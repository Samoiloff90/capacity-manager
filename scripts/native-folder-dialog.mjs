// Development-only: chooses a folder in the native folder dialog the store shows (Q-001), as a
// person would. Since 0.4.0-rc.2 the window can neither stub that dialog nor name a folder:
// project_open and project_create accept only the folder chosen there. Windows UI Automation
// through Win32 messages, like the "Save as" driver of report-export-smoke.mjs.
import { spawn } from "node:child_process";

export const FOLDER_DIALOG_TITLES = { open: "Выберите папку проекта", create: "Выберите пустую папку для команды" };

const win32 = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FolderDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  static string Cls(IntPtr h) { var sb = new StringBuilder(64); GetClassNameW(h, sb, 64); return sb.ToString(); }
  public static IntPtr Button(IntPtr dialog, int id) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (h, l) => { if (GetDlgCtrlID(h) == id && Cls(h) == "Button") { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  // The visible "Folder:" box: an Edit inside a ComboBox.
  public static IntPtr FolderBox(IntPtr dialog) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (h, l) => {
      if (Cls(h) == "Edit" && IsWindowVisible(h) && Cls(GetParent(h)) == "ComboBox") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
`;

/** Starts waiting for the dialog of `purpose`; `folder` null cancels it. Start it before the click. */
export function inFolderDialog(purpose, folder) {
  const title = FOLDER_DIALOG_TITLES[purpose];
  if (!title) throw new Error(`Unknown folder purpose: ${purpose}`);
  const escaped = (value) => value.replaceAll("'", "''");
  const script = `${win32}
$ErrorActionPreference = 'Stop'
$deadline = (Get-Date).AddSeconds(30)
$dialog = [IntPtr]::Zero
while ($dialog -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  $dialog = [FolderDlg]::FindWindowW('#32770', '${escaped(title)}')
  if ($dialog -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($dialog -eq [IntPtr]::Zero) { throw 'Folder dialog "${escaped(title)}" not found' }
Start-Sleep -Milliseconds 500
if (${folder === null ? "$true" : "$false"}) {
  [void][FolderDlg]::PostMessageW([FolderDlg]::Button($dialog, 2), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
} else {
  $box = [FolderDlg]::FolderBox($dialog)
  if ($box -eq [IntPtr]::Zero) { throw 'Folder box not found' }
  [void][FolderDlg]::SendMessageW($box, 0x000C, [IntPtr]::Zero, '${escaped(folder ?? "")}')
  Start-Sleep -Milliseconds 300
  [void][FolderDlg]::PostMessageW([FolderDlg]::Button($dialog, 1), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
}
# The dialog may go into the typed folder instead of choosing it: the next press chooses it.
for ($attempt = 0; $attempt -lt 4; $attempt++) {
  Start-Sleep -Milliseconds 700
  if (-not [FolderDlg]::IsWindow($dialog)) { exit 0 }
  [void][FolderDlg]::PostMessageW([FolderDlg]::Button($dialog, $(if (${folder === null ? "$true" : "$false"}) { 2 } else { 1 })), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
}
Start-Sleep -Milliseconds 700
if ([FolderDlg]::IsWindow($dialog)) { throw 'Folder dialog stayed open' }
`;
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Folder dialog (${purpose}): ${output.trim()}`)));
  });
}
