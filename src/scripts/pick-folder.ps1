# =============================================================================
# Native "Select Folder" dialog for the Data Backup setting.
# =============================================================================
#
# Shows the modern Windows folder picker and prints the chosen path on stdout,
# or nothing at all when the user cancels.
#
# WHY COM INTEROP AND NOT FolderBrowserDialog
#
# Windows PowerShell 5.1 runs on .NET Framework, where
# System.Windows.Forms.FolderBrowserDialog is still the old tree-only dialog
# with no address bar, no navigation pane and no New Folder button. The modern
# picker — the one with "This PC", a path box and a Select Folder button — is
# the shell's common item dialog, reachable only through IFileDialog with the
# FOS_PICKFOLDERS option. That is what this builds.
#
# Usage:
#   powershell -STA -NoProfile -ExecutionPolicy Bypass -File pick-folder.ps1 [-InitialPath <dir>] [-SelfTest]
#
# -SelfTest creates the dialog and releases it without showing anything, so the
# interop can be verified without a dialog appearing on someone's screen.
#
# stdout contract:
#   PATH:<absolute path>   the user chose a folder
#   CANCELLED              the user dismissed the dialog
#   SELFTEST:OK            -SelfTest succeeded
#   ERROR:<message>        something went wrong
# =============================================================================

param(
  [string]$InitialPath = '',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

namespace PosBackup
{
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    // Method order below IS the vtable order; every member must stay declared
    // and in place even when unused, or the wrong function gets called.
    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr hwndOwner);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close([MarshalAs(UnmanagedType.Error)] int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    internal class FileOpenDialogRCW { }

    public static class FolderPicker
    {
        private const uint FOS_PICKFOLDERS = 0x00000020;
        private const uint FOS_FORCEFILESYSTEM = 0x00000040;
        private const uint FOS_PATHMUSTEXIST = 0x00000800;
        private const uint SIGDN_FILESYSPATH = 0x80058000;
        private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out object ppv);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        /// Creates and releases the dialog without showing it.
        public static bool SelfTest()
        {
            object raw = new FileOpenDialogRCW();
            try
            {
                IFileDialog dialog = (IFileDialog)raw;
                dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                return true;
            }
            finally
            {
                Marshal.FinalReleaseComObject(raw);
            }
        }

        /// Returns the chosen folder, or null when cancelled.
        public static string Pick(string initialPath, string title)
        {
            object raw = new FileOpenDialogRCW();
            try
            {
                IFileDialog dialog = (IFileDialog)raw;
                dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);

                if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);

                if (!string.IsNullOrEmpty(initialPath) && System.IO.Directory.Exists(initialPath))
                {
                    Guid shellItemGuid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
                    object item;
                    SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref shellItemGuid, out item);
                    // Opens at the folder while leaving the user free to
                    // navigate away, which SetDefaultFolder would not.
                    dialog.SetFolder((IShellItem)item);
                }

                // A null owner gives a top-level dialog, which can open behind
                // the browser window. Show() blocks this thread, so a
                // background thread waits for the dialog to exist and pulls it
                // to the front by title.
                if (!string.IsNullOrEmpty(title))
                {
                    System.Threading.Thread raise = new System.Threading.Thread(delegate()
                    {
                        for (int attempt = 0; attempt < 50; attempt++)
                        {
                            System.Threading.Thread.Sleep(100);
                            IntPtr handle = FindWindow(null, title);
                            if (handle != IntPtr.Zero)
                            {
                                SetForegroundWindow(handle);
                                return;
                            }
                        }
                    });
                    raise.IsBackground = true;
                    raise.Start();
                }

                // Owner is deliberately null. Passing a window belonging to
                // another process — which is what GetForegroundWindow returns
                // here, since this script owns no windows of its own — makes
                // the shell dialog fail immediately and report a cancellation,
                // indistinguishable from the user dismissing it.
                int hr = dialog.Show(IntPtr.Zero);

                if (hr == ERROR_CANCELLED) return null;
                if (hr != 0) throw Marshal.GetExceptionForHR(hr);

                IShellItem result;
                dialog.GetResult(out result);

                IntPtr pathPtr;
                result.GetDisplayName(SIGDN_FILESYSPATH, out pathPtr);
                try
                {
                    return Marshal.PtrToStringUni(pathPtr);
                }
                finally
                {
                    Marshal.FreeCoTaskMem(pathPtr);
                }
            }
            finally
            {
                Marshal.FinalReleaseComObject(raw);
            }
        }
    }
}
'@

try {
  if (-not ('PosBackup.FolderPicker' -as [type])) {
    Add-Type -TypeDefinition $source -Language CSharp | Out-Null
  }
} catch {
  Write-Output "ERROR:Could not initialise the folder dialog: $($_.Exception.Message)"
  exit 1
}

try {
  if ($SelfTest) {
    [void][PosBackup.FolderPicker]::SelfTest()
    Write-Output 'SELFTEST:OK'
    exit 0
  }

  $chosen = [PosBackup.FolderPicker]::Pick($InitialPath, 'Select Backup Folder')

  if ([string]::IsNullOrEmpty($chosen)) {
    Write-Output 'CANCELLED'
  } else {
    Write-Output "PATH:$chosen"
  }
  exit 0
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
  exit 1
}
