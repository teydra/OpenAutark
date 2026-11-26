// Standalone role of the signed resource. Same token as its caller; no service or IPC.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AutarkBroker
{
    internal static class ShellJob
    {
        internal const string Role = "shell-job-v1";
        internal const string Capability = "autark-shell-job-v1";

        internal static int Run(string[] args)
        {
            if (args.Length < 2 || !Path.IsPathRooted(args[1])) return 2;
            // Only the runtime holds the write end. The child gets NUL, not the control pipe.
            var parent = Console.OpenStandardInput();
            var watch = new Thread(() =>
            {
                try { while (parent.ReadByte() != -1) { } }
                catch (IOException) { }
                Environment.Exit(1); // OS closes our only job handle if the runtime disappears
            });
            watch.IsBackground = true;
            watch.Start();
            try { return Launch(args); }
            catch (Win32Exception e)
            {
                Console.Error.WriteLine("Could not start or wait for the Windows shell job (Win32 " + e.NativeErrorCode + ").");
                return 1;
            }
        }

        static int Launch(string[] args)
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw LastError();
            var child = new ProcessInfo();
            IntPtr attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero;
            bool initialized = false;
            IntPtr input = new IntPtr(-1), output = IntPtr.Zero, error = IntPtr.Zero;
            try
            {
                var limits = new ExtendedLimits();
                limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw LastError();

                var security = new SecurityAttributes {
                    Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = 1
                };
                input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
                if (input == new IntPtr(-1)) throw LastError();
                output = InheritableStdHandle(-11);
                error = InheritableStdHandle(-12);

                // Keep buffers alive through CreateProcess. Only the three stdio handles are inherited.
                jobs = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobs, job);
                handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
                Marshal.WriteIntPtr(handles, 0, input);
                Marshal.WriteIntPtr(handles, IntPtr.Size, output);
                Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, error);
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                if (size == IntPtr.Zero) throw LastError();
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw LastError();
                initialized = true;
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)
                    || !UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw LastError(); // PROC_THREAD_ATTRIBUTE_JOB_LIST and HANDLE_LIST

                var startup = new StartupInfoEx { List = attributes };
                startup.Info.Size = Marshal.SizeOf(startup);
                startup.Info.Flags = 0x100; // STARTF_USESTDHANDLES
                startup.Info.Input = input;
                startup.Info.Output = output;
                startup.Info.Error = error;
                var command = new StringBuilder();
                for (int i = 1; i < args.Length; i++)
                {
                    if (i > 1) command.Append(' ');
                    Quote(command, args[i]);
                }
                // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW. Job membership is atomic with
                // creation, even if the owner is killed during startup. Inherit cwd and environment.
                if (!CreateProcess(args[1], command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000,
                    IntPtr.Zero, null, ref startup, out child)) throw LastError();
                if (WaitForSingleObject(child.Process, 0xffffffff) != 0) throw LastError();
                uint code;
                if (!GetExitCodeProcess(child.Process, out code)) throw LastError();
                return unchecked((int)code);
            }
            finally
            {
                CloseHandle(job);
                if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
                if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
                if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
                if (input != new IntPtr(-1)) CloseHandle(input);
                if (output != IntPtr.Zero) CloseHandle(output);
                if (error != IntPtr.Zero) CloseHandle(error);
            }
        }

        // Backslashes before a quote (including the closing quote) must be doubled.
        static void Quote(StringBuilder result, string arg)
        {
            result.Append('"');
            int slashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? 2 * slashes + 1 : slashes);
                result.Append(c);
                slashes = 0;
            }
            result.Append('\\', 2 * slashes);
            result.Append('"');
        }

        static IntPtr InheritableStdHandle(int id)
        {
            IntPtr self = GetCurrentProcess(), copy;
            if (!DuplicateHandle(self, GetStdHandle(id), self, out copy, 0, true, 2)) throw LastError();
            return copy;
        }

        static Win32Exception LastError() { return new Win32Exception(Marshal.GetLastWin32Error()); }

        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; internal int InheritHandle; }

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            internal long ProcessTime, JobTime;
            internal uint Flags;
            internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint Priority, Scheduling;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            internal BasicLimits Basic;
            internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            internal ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
            internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct StartupInfo
        {
            internal int Size;
            internal IntPtr Reserved, Desktop, Title;
            internal uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            internal ushort Show, ReservedSize;
            internal IntPtr Reserved2, Input, Output, Error;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct StartupInfoEx { internal StartupInfo Info; internal IntPtr List; }
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInfo { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr key, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
        [DllImport("kernel32.dll")]
        static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcess(string image, StringBuilder command, IntPtr procAttributes, IntPtr threadAttributes,
            bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfoEx startup, out ProcessInfo child);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")]
        static extern IntPtr GetStdHandle(int id);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);
    }
}
