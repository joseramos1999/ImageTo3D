; Instalador de ImageTo3D (Inno Setup 6).
; No se compila a mano: lo lanza Compilar-ImageTo3D.ps1, que publica la app y pasa
; la versión y la carpeta publicada con /DAppVersion y /DSourceDir.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\build\publish"
#endif

#define AppName "ImageTo3D"
#define AppExe  "ImageTo3D.exe"

[Setup]
; El AppId identifica la app entre versiones: no cambiarlo nunca, o las actualizaciones
; se instalarían al lado en vez de encima.
AppId={{6F1E2B7C-3D9A-4C5E-9B8F-2A7D4E1C6B30}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Instalador de {#AppName}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Por defecto se instala solo para el usuario actual, sin pedir administrador;
; el asistente deja elegir "para todos los usuarios" si se quiere.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\build\installer
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
SetupIconFile=..\src\ImageTo3D\app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; Si la app está abierta durante una actualización, se ofrece cerrarla y se vuelve a abrir.
CloseApplications=yes
RestartApplications=yes
; Registers .i3d (per user or machine-wide, matching the install mode).
ChangesAssociations=yes

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
spanish.NoWebView2=No se ha encontrado Microsoft Edge WebView2 Runtime, que ImageTo3D necesita para dibujar en 3D.%n%nViene con Windows 11 y con Windows 10 actualizado. ¿Abrir la página de descarga de Microsoft? (La instalación continuará igualmente.)
english.NoWebView2=Microsoft Edge WebView2 Runtime, which ImageTo3D needs to render in 3D, was not found.%n%nIt ships with Windows 11 and up-to-date Windows 10. Open Microsoft's download page? (Setup will continue anyway.)

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; Double-clicking a project opens it in ImageTo3D.
Root: HKA; Subkey: "Software\Classes\.i3d"; ValueType: string; ValueName: ""; ValueData: "ImageTo3D.Project"; Flags: uninsdeletevalue
Root: HKA; Subkey: "Software\Classes\ImageTo3D.Project"; ValueType: string; ValueName: ""; ValueData: "Proyecto ImageTo3D"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\ImageTo3D.Project\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExe},0"
Root: HKA; Subkey: "Software\Classes\ImageTo3D.Project\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Caché de WebView2 y ajustes guardados (carpeta creada por la app en el primer arranque).
Type: filesandordirs; Name: "{localappdata}\{#AppName}"

[Code]
const
  WebView2Key = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasVersion(Root: Integer; SubKey: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, SubKey, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

function WebView2Installed(): Boolean;
begin
  Result := HasVersion(HKLM, 'SOFTWARE\WOW6432Node\' + WebView2Key)
         or HasVersion(HKLM, 'SOFTWARE\' + WebView2Key)
         or HasVersion(HKCU, 'Software\' + WebView2Key);
end;

// Los procesos de WebView2 siguen vivos un par de segundos después de cerrar la app y
// bloquean su caché; [UninstallDelete] lo intenta una sola vez, aquí se reintenta.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  Tries: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\{#AppName}');
    Tries := 0;
    while DirExists(DataDir) and (Tries < 20) do
    begin
      DelTree(DataDir, True, True, True);
      if DirExists(DataDir) then Sleep(500);
      Tries := Tries + 1;
    end;
  end;
end;

function InitializeSetup(): Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if not WebView2Installed() then
    if SuppressibleMsgBox(CustomMessage('NoWebView2'), mbConfirmation, MB_YESNO, IDNO) = IDYES then
      ShellExec('open', 'https://go.microsoft.com/fwlink/p/?LinkId=2124703', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;
