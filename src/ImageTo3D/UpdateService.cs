using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace ImageTo3D;

/// <summary>
/// Self-update from GitHub Releases: compares the latest release's tag with this build's
/// version, downloads its installer, checks it against the SHA-256 digest GitHub publishes,
/// and runs it silently. The installer (same AppId) updates in place and relaunches the app.
/// </summary>
public sealed class UpdateService
{
    private const string LatestReleaseApi = "https://api.github.com/repos/joseramos1999/ImageTo3D/releases/latest";

    public sealed record Release(Version Version, string Tag, string Notes, string PageUrl,
        string AssetName, string AssetUrl, long AssetSize, string? Sha256);

    // Declared before Http: static initializers run in order, and the client's User-Agent uses it.
    public static Version Current { get; } =
        Assembly.GetEntryAssembly()?.GetName().Version is { } v ? new Version(v.Major, v.Minor, Math.Max(0, v.Build)) : new Version(0, 0, 0);

    private static readonly HttpClient Http = CreateClient();

    // For testing against a local server: IMAGETO3D_UPDATE_URL points at a release JSON in
    // the GitHub API shape, and lifts the github.com-only rule for its download.
    private static readonly string? TestUrl = Environment.GetEnvironmentVariable("IMAGETO3D_UPDATE_URL");

    private static HttpClient CreateClient()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromMinutes(15) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"ImageTo3D/{Current}");
        http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return http;
    }

    /// <summary>The latest release if it is newer than this build, otherwise null.</summary>
    public async Task<Release?> CheckAsync(CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));
        using var resp = await Http.GetAsync(TestUrl ?? LatestReleaseApi, cts.Token);
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(cts.Token));
        var root = doc.RootElement;

        var tag = root.GetProperty("tag_name").GetString() ?? "";
        if (root.TryGetProperty("draft", out var draft) && draft.GetBoolean()) return null;
        if (root.TryGetProperty("prerelease", out var pre) && pre.GetBoolean()) return null;
        if (!Version.TryParse(tag.TrimStart('v', 'V'), out var version)) return null;
        version = new Version(version.Major, version.Minor, Math.Max(0, version.Build));
        if (version <= Current) return null;

        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            var name = asset.GetProperty("name").GetString() ?? "";
            if (!name.StartsWith("ImageTo3D-Setup-", StringComparison.OrdinalIgnoreCase) ||
                !name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
            var url = asset.GetProperty("browser_download_url").GetString() ?? "";
            if (TestUrl == null && !url.StartsWith("https://github.com/joseramos1999/ImageTo3D/releases/download/", StringComparison.OrdinalIgnoreCase))
                continue;   // only ever download from this project's own releases
            // Without a well-formed SHA-256 the release is still announced, but it is never
            // installed automatically (DownloadAsync refuses it): the user is sent to its page.
            string? sha = null;
            if (asset.TryGetProperty("digest", out var digest) && digest.GetString() is { } d &&
                d.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) && IsSha256(d[7..]))
                sha = d[7..].ToLowerInvariant();
            return new Release(version, tag,
                root.TryGetProperty("body", out var body) ? body.GetString() ?? "" : "",
                root.TryGetProperty("html_url", out var page) ? page.GetString() ?? "" : "",
                name, url, asset.GetProperty("size").GetInt64(), sha);
        }
        return null;
    }

    private static bool IsSha256(string hex) => hex.Length == 64 && hex.All(Uri.IsHexDigit);

    /// <summary>True for this project's release pages on GitHub (the only pages the app opens).</summary>
    public static bool IsReleasePage(string url) =>
        url.StartsWith("https://github.com/joseramos1999/ImageTo3D/releases/", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Downloads the installer to %TEMP% and verifies its size and SHA-256. A release without
    /// a published SHA-256 is refused before anything is downloaded.
    /// </summary>
    public async Task<string> DownloadAsync(Release release, IProgress<double> progress, CancellationToken ct = default)
    {
        if (release.Sha256 == null || !IsSha256(release.Sha256))
            throw new InvalidDataException("GitHub no publica la huella SHA-256 de este instalador y no se puede verificar. Descárgalo desde la página de la versión.");
        var dir = Path.Combine(Path.GetTempPath(), "ImageTo3D-update");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, Path.GetFileName(release.AssetName));
        var partial = path + ".part";

        using (var resp = await Http.GetAsync(release.AssetUrl, HttpCompletionOption.ResponseHeadersRead, ct))
        {
            resp.EnsureSuccessStatusCode();
            await using var src = await resp.Content.ReadAsStreamAsync(ct);
            await using var dst = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20);
            var buffer = new byte[1 << 20];
            long done = 0;
            int read;
            while ((read = await src.ReadAsync(buffer, ct)) > 0)
            {
                await dst.WriteAsync(buffer.AsMemory(0, read), ct);
                done += read;
                progress.Report(release.AssetSize > 0 ? (double)done / release.AssetSize : 0);
            }
        }

        var size = new FileInfo(partial).Length;
        if (release.AssetSize > 0 && size != release.AssetSize)
            Fail(partial, $"la descarga está incompleta ({size} de {release.AssetSize} bytes)");
        string hash;
        await using (var fs = File.OpenRead(partial))
            hash = Convert.ToHexString(await SHA256.HashDataAsync(fs, ct)).ToLowerInvariant();
        if (hash != release.Sha256) Fail(partial, "la huella SHA-256 no coincide con la publicada");
        File.Move(partial, path, overwrite: true);
        return path;
    }

    private static void Fail(string file, string reason)
    {
        try { File.Delete(file); } catch (IOException) { /* best effort */ }
        throw new InvalidDataException(reason);
    }

    /// <summary>
    /// Runs the installer silently over the current install (same scope: per user or for all
    /// users) and asks it to reopen the app when done. The caller then closes the app.
    /// </summary>
    public static void LaunchInstaller(string installerPath)
    {
        var appDir = AppContext.BaseDirectory;
        var perUser = appDir.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), StringComparison.OrdinalIgnoreCase);
        var args = $"/SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /RELAUNCH=1 {(perUser ? "/CURRENTUSER" : "/ALLUSERS")}";
        Process.Start(new ProcessStartInfo(installerPath, args) { UseShellExecute = true });
    }
}
