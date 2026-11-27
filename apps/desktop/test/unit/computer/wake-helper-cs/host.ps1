# Runs resources/broker/WakeHelper.cs's Program.Main in THIS PowerShell process (compiled in memory, no exe file), with the helper's own
# command line: host.ps1 <data>\wake.json --app <Autark.exe> -- <app arguments>. For a PC where Smart App Control refuses every new
# unsigned exe (the test cannot run a fresh AutarkWakeHelper.exe there) – wake-helper.test.ts uses it only then. The exit code is Main's.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..\..\..')
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateInMemory = $true
foreach ($file in @('System.dll', 'System.Core.dll', 'System.Numerics.dll')) { [void]$parameters.ReferencedAssemblies.Add((Join-Path $framework $file)) }
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
$result = $provider.CompileAssemblyFromFile($parameters, [string[]]@((Join-Path $root 'resources\broker\WakeHelper.cs')))
if ($result.Errors.HasErrors) { $result.Errors | ForEach-Object { Write-Output $_.ToString() }; exit 2 }
$code = $result.CompiledAssembly.GetType('AutarkWake.Program').GetMethod('Main').Invoke($null, @(, [string[]]$args))
exit $code
