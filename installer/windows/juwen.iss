; ============================================================================
;  juwen —— Inno Setup 6 脚本（Windows 安装包）
;
;  由 scripts/package-release.mjs 调用，参数全部走 /D：
;    ISCC.exe /DAppVersion=0.1.0 /DStageDir=<staging 绝对路径> /O<输出目录> /F<文件名> juwen.iss
;
;  设计要点：
;    · PrivilegesRequired=lowest → 按用户安装到 {localappdata}\Programs\juwen，
;      不弹 UAC（用户目录下才有写权限；装到 Program Files 反而会写不进去）。
;    · 卸载只删 {app}，**绝不删用户数据目录**（%APPDATA%\juwen，见启动器注释）。
;    · 本文件保存为 UTF-8 with BOM：Inno 6 只有见到 BOM 才按 UTF-8 解析，
;      否则「启动 juwen.cmd」这个中文文件名会乱码、编译失败。
;    · 刻意不引入 [Languages]：中文语言包（ChineseSimplified.isl）并非 Inno 官方
;      自带文件，CI 上会「Could not read file」直接失败；因此向导界面保持英文，
;      只有下面少量中文文案（AppComments / 快捷方式说明）。
;    · Windows 安装包**未做代码签名**，首次运行会有 SmartScreen 提示，
;      这是没有证书时的必然现象，CI 里无法消除。
; ============================================================================

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\release\juwen-0.0.0-win-x64"
#endif

[Setup]
; AppId 用固定 GUID：升级时能认出旧版本、走覆盖安装
AppId={{6F1B4C7E-2D9A-4E3B-9C51-7A28D4E6B913}
AppName=juwen
AppVersion={#AppVersion}
AppVerName=juwen {#AppVersion}
AppPublisher=Yujie
AppComments=智能解读工作台
DefaultDirName={localappdata}\Programs\juwen
DisableDirPage=no
DisableProgramGroupPage=yes
DefaultGroupName=juwen
UninstallDisplayName=juwen
UninstallDisplayIcon={app}\runtime\node.exe
; 免管理员：按用户安装，避免 UAC
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
OutputDir=.
OutputBaseFilename=juwen-{#AppVersion}-win-x64-setup
; 版本号仅用于「程序与功能」显示，不写死为字符串以免 Setup 报错
VersionInfoVersion={#AppVersion}

[Files]
; staging 里已经含 server/ dist/ node_modules/ runtime/node.exe 启动器 等全部运行所需文件
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: unchecked

[Icons]
Name: "{group}\juwen"; Filename: "{app}\启动 juwen.cmd"; WorkingDir: "{app}"
Name: "{group}\卸载 juwen"; Filename: "{uninstallexe}"
Name: "{autodesktop}\juwen"; Filename: "{app}\启动 juwen.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\启动 juwen.cmd"; Description: "立即运行 juwen"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; 只清理安装目录。用户数据在 %APPDATA%\juwen（.env / data / 批注），
; 卸载不删——列在这里是为了显式声明「不越界」，而不是要删别的东西。
Type: filesandordirs; Name: "{app}"
