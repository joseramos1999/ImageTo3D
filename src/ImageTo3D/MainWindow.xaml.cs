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

    public MainWindow()
    {
        InitializeComponent();
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

        var core = Web.CoreWebView2;
        var root = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        core.SetVirtualHostNameToFolderMapping(Host, root, CoreWebView2HostResourceAccessKind.Allow);

#if !DEBUG
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;

        core.DownloadStarting += OnDownloadStarting;
        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += (_, _) => Splash.Visibility = Visibility.Collapsed;

        core.Navigate($"https://{Host}/index.html");
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

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
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
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Bad web message: {ex.Message}");
        }
    }

    private void Post(object payload) =>
        Web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(payload));

    private static string DefaultFolderFor(string ext) => ext switch
    {
        "mp4" or "webm" => Environment.GetFolderPath(Environment.SpecialFolder.MyVideos),
        "png" => Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
        _ => Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
    };

    private static string FilterFor(string ext) => ext switch
    {
        "mp4" => "Vídeo MP4 (*.mp4)|*.mp4",
        "webm" => "Vídeo WebM (*.webm)|*.webm",
        "png" => "Imagen PNG (*.png)|*.png",
        "glb" => "Modelo glTF binario (*.glb)|*.glb",
        "stl" => "Modelo STL (*.stl)|*.stl",
        _ => "Todos los archivos (*.*)|*.*",
    };
}
