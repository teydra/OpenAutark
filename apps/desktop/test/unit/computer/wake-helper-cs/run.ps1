# Compiles resources/broker/WakeHelper.cs with WakeHelperTests.cs in memory (CodeDom, the csc of .NET Framework 4.x) and runs the
# tests in this PowerShell process: no new exe is started (a fresh unsigned test exe may be held by Smart App Control).
# Exit code: 0 all pass, 1 a case failed, 2 compile error.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..\..\..')
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateInMemory = $true
foreach ($file in @('System.dll', 'System.Core.dll', 'System.Numerics.dll')) {
  [void]$parameters.ReferencedAssemblies.Add((Join-Path $framework $file))
}
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
$result = $provider.CompileAssemblyFromFile($parameters, [string[]]@((Join-Path $root 'resources\broker\WakeHelper.cs'), (Join-Path $here 'WakeHelperTests.cs')))
if ($result.Errors.HasErrors) { $result.Errors | ForEach-Object { Write-Output $_.ToString() }; exit 2 }
$code = $result.CompiledAssembly.GetType('AutarkWakeTests.WakeHelperTests').GetMethod('Main').Invoke($null, @())
exit $code
