using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace ImageTo3D;

public partial class MainWindow : Window
{
    private const string Host = "app.imageto3d";

    // A project double-clicked in Explorer arrives as the first argument; it is handed to
    // the engine once it reports "ready".
    private string? _pendingProject;

    public MainWindow()
    {
        InitializeComponent();
        // A window closed mid-export leaves no half-written video behind.
        Closed += (_, _) =>
        {
            foreach (var sink in _sinks.Values) sink.Discard();
            _sinks.Clear();
        };
        var args = Environment.GetCommandLineArgs();
        if (args.Length > 1 && File.Exists(args[1]) &&
            string.Equals(Path.GetExtension(args[1]), ".i3d", StringComparison.OrdinalIgnoreCase))
            _pendingProject = args[1];
        Loaded += async (_, _) => await InitWebViewAsync();
    }

    private async Task InitWebViewAsync()
    {
        try
        {
            var dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ImageTo3D", "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: dataDir);
            await Web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "Falta Microsoft Edge WebView2 Runtime.\nDescárgalo desde https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                "ImageTo3D", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
            return;
        }
        catch (Exception ex)
        {
            // The local profile could not be created or opened: no permission, disk full,
            // a damaged cache... Retrying runs the whole WebView2 setup again.
            Debug.WriteLine($"WebView2 init failed: {ex}");
            ShowError($"No se pudo iniciar el componente WebView2: {ex.Message}\n\nComprueba que hay espacio libre en el disco y permisos en %LOCALAPPDATA%\\ImageTo3D.");
            return;
        }

        var core = Web.CoreWebView2;
        var root = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (!File.Exists(Path.Combine(root, "index.html")))
        {
            ShowError($"Falta la carpeta del motor junto al ejecutable:\n{root}\n\nReinstala la aplicación.", canRetry: false);
            return;
        }
        core.SetVirtualHostNameToFolderMapping(Host, root, CoreWebView2HostResourceAccessKind.Allow);

#if !DEBUG
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;

        // The WebView only ever shows the engine: any other page is refused, and so are pop-ups.
        core.NavigationStarting += (_, e) => { if (!IsAppPage(e.Uri)) e.Cancel = true; };
        core.FrameNavigationStarting += (_, e) => { if (!IsAppPage(e.Uri)) e.Cancel = true; };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.DownloadStarting += OnDownloadStarting;
        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += OnNavigationCompleted;
        core.ProcessFailed += OnProcessFailed;

        _readyTimer.Interval = TimeSpan.FromSeconds(20);
        _readyTimer.Tick += (_, _) =>
        {
            _readyTimer.Stop();
            ShowError("El motor 3D no ha terminado de arrancar. Puede que la tarjeta gráfica o sus controladores no admitan WebGL 2.");
        };

        Navigate();
    }

    // The page loading is not enough: the engine reports "ready" once WebGL and the
    // scene are up, so a failure in between still ends on a recoverable error screen.
    private readonly System.Windows.Threading.DispatcherTimer _readyTimer = new();

    private void Navigate()
    {
        ErrorPanel.Visibility = Visibility.Collapsed;
        Splash.Visibility = Visibility.Visible;
        Web.CoreWebView2.Navigate($"https://{Host}/index.html");
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            ShowError($"La página del motor no se pudo abrir ({e.WebErrorStatus}).");
            return;
        }
        _readyTimer.Stop();
        _readyTimer.Start();
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        // The browser process going away takes the whole control with it; renderer or GPU
        // crashes can be recovered by reloading the page.
        var fatal = e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited;
        ShowError(fatal
            ? "El componente WebView2 se ha cerrado inesperadamente. Cierra y vuelve a abrir la aplicación."
            : $"El motor 3D se ha detenido ({e.ProcessFailedKind}). Tu último trabajo se recupera al reintentar.",
            canRetry: !fatal);
    }

    private void ShowError(string message, bool canRetry = true)
    {
        _readyTimer.Stop();
        Splash.Visibility = Visibility.Collapsed;
        ErrorText.Text = message;
        RetryButton.Visibility = canRetry ? Visibility.Visible : Visibility.Collapsed;
        ErrorPanel.Visibility = Visibility.Visible;
    }

    private void OnRetry(object sender, RoutedEventArgs e)
    {
        if (Web.CoreWebView2 != null) Navigate();
        else
        {
            // WebView2 never started (see InitWebViewAsync): try the whole setup again.
            ErrorPanel.Visibility = Visibility.Collapsed;
            Splash.Visibility = Visibility.Visible;
            _ = InitWebViewAsync();
        }
    }

    // Every export in the engine ends in a blob download; intercept it so the user gets
    // a native "Save as" dialog instead of the browser download flyout.
    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        var deferral = e.GetDeferral();
        Dispatcher.BeginInvoke(() =>
        {
            using (deferral)
            {
                var suggested = Path.GetFileName(e.ResultFilePath);
                var ext = Path.GetExtension(suggested).TrimStart('.').ToLowerInvariant();
                var dlg = new SaveFileDialog
                {
                    FileName = suggested,
                    InitialDirectory = DefaultFolderFor(ext),
                    Filter = FilterFor(ext),
                    AddExtension = true,
                    OverwritePrompt = true,
                };
                if (dlg.ShowDialog(this) != true)
                {
                    e.Cancel = true;
                    Post(new { type = "save-cancelled" });
                    return;
                }

                e.ResultFilePath = dlg.FileName;
                e.Handled = true;
                var op = e.DownloadOperation;
                op.StateChanged += (_, _) =>
                {
                    if (op.State == CoreWebView2DownloadState.Completed)
                        Post(new { type = "saved", path = op.ResultFilePath });
                    else if (op.State == CoreWebView2DownloadState.Interrupted)
                        Post(new { type = "save-failed", reason = op.InterruptReason.ToString() });
                };
            }
        });
    }

    /// <summary>True only for pages of the engine itself (https://app.imageto3d/...).</summary>
    private static bool IsAppPage(string? uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps &&
        string.Equals(u.Host, Host, StringComparison.OrdinalIgnoreCase) && u.IsDefaultPort;

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Messages open save dialogs and write files: only the engine's own page may send them.
        if (!IsAppPage(e.Source))
        {
            Debug.WriteLine($"Message from an unexpected page ignored: {e.Source}");
            return;
        }
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var msg = doc.RootElement;
            switch (msg.GetProperty("type").GetString())
            {
                case "reveal":
                    var path = msg.GetProperty("path").GetString();
                    if (path != null && File.Exists(path))
                        Process.Start("explorer.exe", $"/select,\"{path}\"");
                    break;
                case "title":
                    Title = msg.GetProperty("text").GetString() ?? Title;
                    break;
                case "file-open":
                case "file-write":
                case "file-write-shared":
                case "file-close":
                case "file-abort":
                    OnFileMessage(msg);
                    break;
                case "ready":
                    _readyTimer.Stop();
                    Splash.Visibility = Visibility.Collapsed;
                    OpenPendingProject();
                    Post(new { type = "host-info", version = UpdateService.Current.ToString() });
                    StartUpdateChecks();
                    break;
                case "update-check":
                    _ = CheckForUpdateAsync(manual: true);
                    break;
                case "update-install":
                    _ = InstallUpdateAsync();
                    break;
                case "open-release":
                    // Only the page of the version on offer, and only on this project's GitHub.
                    if (_available is { } offered && UpdateService.IsReleasePage(offered.PageUrl))
                        Process.Start(new ProcessStartInfo(offered.PageUrl) { UseShellExecute = true });
                    break;
                case "engine-error":
                    ShowError("El motor 3D no pudo arrancar: " + (msg.GetProperty("message").GetString() ?? "error desconocido"));
                    break;
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Bad web message: {ex.Message}");
        }
    }

    // ── Streamed exports ──
    // Long videos are written to disk while they encode instead of being assembled in
    // memory: the engine asks for a file (native "Save as" up front), sends the chunks
    // with their byte offset (the MP4 header is patched at the end), then closes it.
    // The chunks travel through a buffer shared with the page: the engine copies each one
    // in and says where it goes ("file-write-shared"), with no base64 or JSON in between
    // (an uncompressed AVI moves ~8 MB per frame). Base64 "file-write" is the fallback.
    private sealed record Sink(FileStream Stream, string Path, CoreWebView2SharedBuffer? Shared)
    {
        public void Discard()
        {
            Dispose();
            try { File.Delete(Path); } catch (IOException) { /* best effort */ }
        }

        public void Dispose()
        {
            Stream.Dispose();
            Shared?.Dispose();
        }
    }

    private const int SharedBufferBytes = 16 << 20;
    private readonly Dictionary<string, Sink> _sinks = new();
    private byte[]? _copyBuffer;

    private void OnFileMessage(JsonElement msg)
    {
        var type = msg.GetProperty("type").GetString();
        var id = msg.GetProperty("id").GetString() ?? "";
        try
        {
            switch (type)
            {
                case "file-open":
                    var name = msg.GetProperty("name").GetString() ?? "export";
                    // Deferred: a modal dialog inside the WebView2 event handler can re-enter it.
                    Dispatcher.BeginInvoke(() => OpenSink(id, name));
                    break;
                case "file-write":
                    var sink = _sinks[id];
                    var bytes = Convert.FromBase64String(msg.GetProperty("data").GetString() ?? "");
                    sink.Stream.Seek(msg.GetProperty("pos").GetInt64(), SeekOrigin.Begin);
                    sink.Stream.Write(bytes, 0, bytes.Length);
                    Post(new { type = "file-ack", id });
                    break;
                case "file-write-shared":
                    var target = _sinks[id];
                    var length = msg.GetProperty("len").GetInt32();
                    if (target.Shared == null || length < 0 || length > SharedBufferBytes) throw new InvalidOperationException("trozo no válido");
                    _copyBuffer ??= new byte[SharedBufferBytes];
                    using (var shared = target.Shared.OpenStream())
                        shared.ReadExactly(_copyBuffer, 0, length);
                    target.Stream.Seek(msg.GetProperty("pos").GetInt64(), SeekOrigin.Begin);
                    target.Stream.Write(_copyBuffer, 0, length);
                    Post(new { type = "file-ack", id });
                    break;
                case "file-close":
                    if (_sinks.Remove(id, out var done))
                    {
                        done.Dispose();
                        Post(new { type = "file-closed", id });
                        Post(new { type = "saved", path = done.Path });
                    }
                    break;
                case "file-abort":
                    if (_sinks.Remove(id, out var aborted)) aborted.Discard();
                    Post(new { type = "file-closed", id });
                    break;
            }
        }
        catch (Exception ex)
        {
            // Disk full, file locked...: the engine stops the export and tells the user.
            if (_sinks.Remove(id, out var broken)) broken.Discard();
            Post(new { type = "file-error", id, message = ex.Message });
        }
    }

    private void OpenSink(string id, string suggested)
    {
        var ext = Path.GetExtension(suggested).TrimStart('.').ToLowerInvariant();
        var dlg = new SaveFileDialog
        {
            FileName = suggested,
            InitialDirectory = DefaultFolderFor(ext),
            Filter = FilterFor(ext),
            AddExtension = true,
            OverwritePrompt = true,
        };
        string? path = null;
#if DEBUG
        // Automated export tests: save straight to this path, without the dialog.
        path = Environment.GetEnvironmentVariable("IMAGETO3D_TEST_SAVE");
#endif
        if (string.IsNullOrEmpty(path))
        {
            if (dlg.ShowDialog(this) != true)
            {
                Post(new { type = "file-cancelled", id });
                return;
            }
            path = dlg.FileName;
        }
        try
        {
            var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 20);
            CoreWebView2SharedBuffer? shared = null;
            try
            {
                shared = Web.CoreWebView2.Environment.CreateSharedBuffer(SharedBufferBytes);
                Web.CoreWebView2.PostSharedBufferToScript(shared, CoreWebView2SharedBufferAccess.ReadWrite,
                    JsonSerializer.Serialize(new { type = "file-buffer", id }));
            }
            catch (Exception ex)
            {
                // An older WebView2 Runtime: the chunks come as base64 messages instead.
                Debug.WriteLine($"Shared buffer unavailable: {ex.Message}");
                shared?.Dispose();
                shared = null;
            }
            _sinks[id] = new Sink(fs, path, shared);
            Post(new { type = "file-opened", id, path });
        }
        catch (Exception ex)
        {
            Post(new { type = "file-error", id, message = ex.Message });
        }
    }

    // ── Self-update (see UpdateService) ──
    private readonly UpdateService _updates = new();
    private UpdateService.Release? _available;
    private System.Windows.Threading.DispatcherTimer? _updateTimer;
    private bool _installing;

    private void StartUpdateChecks()
    {
        if (_updateTimer != null) return;   // a page reload sends "ready" again
#if DEBUG
        // Development builds only check on demand, unless pointed at a test feed.
        if (Environment.GetEnvironmentVariable("IMAGETO3D_UPDATE_URL") == null) return;
#endif
        _updateTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromHours(12) };
        _updateTimer.Tick += (_, _) => _ = CheckForUpdateAsync(manual: false);
        _updateTimer.Start();
        // Not at the very first second: let the app finish starting first.
        _ = Task.Delay(TimeSpan.FromSeconds(4)).ContinueWith(_ => Dispatcher.BeginInvoke(() => CheckForUpdateAsync(manual: false)));
    }

    private async Task CheckForUpdateAsync(bool manual)
    {
        try
        {
            _available = await _updates.CheckAsync();
            if (_available is { } r)
                Post(new { type = "update-available", version = r.Version.ToString(), current = UpdateService.Current.ToString(), notes = r.Notes, page = r.PageUrl, size = r.AssetSize, verified = r.Sha256 != null });
            else if (manual)
                Post(new { type = "update-none", current = UpdateService.Current.ToString() });
        }
        catch (Exception ex)
        {
            // Offline or GitHub unreachable: stay quiet unless the user asked.
            Debug.WriteLine($"Update check failed: {ex.Message}");
            if (manual) Post(new { type = "update-error", message = "No se pudo consultar si hay una versión nueva. Comprueba la conexión." });
        }
    }

    private async Task InstallUpdateAsync()
    {
        if (_installing) return;
        _installing = true;
        try
        {
            var release = _available ?? await _updates.CheckAsync();
            if (release == null) { Post(new { type = "update-none", current = UpdateService.Current.ToString() }); return; }
            var last = -1;
            var progress = new Progress<double>(p =>
            {
                var pct = (int)(p * 100);
                if (pct == last) return;
                last = pct;
                Post(new { type = "update-progress", p });
            });
            var installer = await _updates.DownloadAsync(release, progress);
            Post(new { type = "update-installing", version = release.Version.ToString() });
            await Task.Delay(600);   // let the message paint
            UpdateService.LaunchInstaller(installer);
            Application.Current.Shutdown();
        }
        catch (Exception ex)
        {
            Post(new { type = "update-error", message = "No se pudo actualizar: " + ex.Message });
        }
        finally
        {
            _installing = false;
        }
    }

    private void OpenPendingProject()
    {
        var path = _pendingProject;
        _pendingProject = null;
        if (path == null) return;
        try
        {
            if (new FileInfo(path).Length > 400L * 1024 * 1024)
                throw new IOException("el archivo pesa más de 400 MB");
            Post(new { type = "open-project", name = Path.GetFileName(path), text = File.ReadAllText(path) });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"No se pudo abrir el proyecto:\n{path}\n\n{ex.Message}", "ImageTo3D",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void Post(object payload) =>
        Web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(payload));

    private static string DefaultFolderFor(string ext) => ext switch
    {
        "mp4" or "webm" or "avi" or "zip" => Environment.GetFolderPath(Environment.SpecialFolder.MyVideos),
        "png" => Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
        _ => Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
    };

    private static string FilterFor(string ext) => ext switch
    {
        "mp4" => "Vídeo MP4 (*.mp4)|*.mp4",
        "webm" => "Vídeo WebM (*.webm)|*.webm",
        "avi" => "Vídeo AVI (*.avi)|*.avi",
        "png" => "Imagen PNG (*.png)|*.png",
        "glb" => "Modelo glTF binario (*.glb)|*.glb",
        "stl" => "Modelo STL (*.stl)|*.stl",
        "i3d" => "Proyecto ImageTo3D (*.i3d)|*.i3d",
        "zip" => "Secuencia PNG en ZIP (*.zip)|*.zip",
        _ => "Todos los archivos (*.*)|*.*",
    };
}
