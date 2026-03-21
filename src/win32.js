import { spawn } from "node:child_process";

import { CLIError } from "./errors.js";

export function isWindows() {
  return process.platform === "win32";
}

export function toPowerShellStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function toPowerShellBooleanLiteral(value) {
  return value ? "$true" : "$false";
}

export function getWin32Prelude(options = {}) {
  const includeSendKeys = options.sendKeys === true;
  const includeUiAutomation = options.uiAutomation === true;

  return `
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class TermhubNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

${includeSendKeys ? "Add-Type -AssemblyName System.Windows.Forms" : ""}
${includeUiAutomation ? "Add-Type -AssemblyName UIAutomationClient\nAdd-Type -AssemblyName UIAutomationTypes" : ""}

function ConvertTo-TermhubText([object]$value) {
  if ($null -eq $value) {
    return $null
  }

  $text = [string]$value
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }

  return $text.Trim()
}

function Get-TermhubForegroundHandle() {
  return [int64][TermhubNative]::GetForegroundWindow()
}

function Get-TermhubProcessIdFromHandle([int64]$windowHandle) {
  if ($windowHandle -eq 0) {
    return 0
  }

  [uint32]$processId = 0
  [void][TermhubNative]::GetWindowThreadProcessId([IntPtr]$windowHandle, [ref]$processId)
  return [int]$processId
}

function Set-TermhubForeground([int64]$windowHandle) {
  if ($windowHandle -eq 0) {
    return $false
  }

  if ([TermhubNative]::IsIconic([IntPtr]$windowHandle)) {
    [void][TermhubNative]::ShowWindow([IntPtr]$windowHandle, 9)
  }

  Start-Sleep -Milliseconds 40
  $result = [TermhubNative]::SetForegroundWindow([IntPtr]$windowHandle)
  Start-Sleep -Milliseconds 80
  return $result
}

function Find-TermhubWindowElementByHandle([int64]$windowHandle) {
  $children = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  foreach ($child in $children) {
    try {
      if ([int64]$child.Current.NativeWindowHandle -eq $windowHandle) {
        return $child
      }
    } catch { }
  }

  return $null
}

function Get-TermhubTopLevelWindows() {
  $children = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  $windows = @()

  foreach ($child in $children) {
    try {
      $windowHandle = [int64]$child.Current.NativeWindowHandle
    } catch {
      continue
    }

    if ($windowHandle -eq 0) {
      continue
    }

    $windows += [pscustomobject]@{
      windowHandle = $windowHandle
      processId = [int]$child.Current.ProcessId
      title = ConvertTo-TermhubText $child.Current.Name
      className = ConvertTo-TermhubText $child.Current.ClassName
      automationId = ConvertTo-TermhubText $child.Current.AutomationId
    }
  }

  return @($windows)
}

function Get-TermhubTabElements([int64]$windowHandle) {
  $window = Find-TermhubWindowElementByHandle $windowHandle
  if ($null -eq $window) {
    return @()
  }

  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem
  )

  $matches = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )

  $items = @()
  foreach ($item in $matches) {
    $items += $item
  }

  return @($items)
}

function Get-TermhubTabInfos([int64]$windowHandle) {
  $items = @(Get-TermhubTabElements $windowHandle)
  $tabs = @()
  $index = 0

  foreach ($item in $items) {
    $index += 1
    $isSelected = $false

    try {
      $pattern = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($null -ne $pattern) {
        $isSelected = $pattern.Current.IsSelected
      }
    } catch { }

    $title = ConvertTo-TermhubText $item.Current.Name
    if ([string]::IsNullOrWhiteSpace($title)) {
      $title = "Tab $index"
    }

    $tabs += [pscustomobject]@{
      tabIndex = $index
      title = $title
      isCurrent = $isSelected
      automationId = ConvertTo-TermhubText $item.Current.AutomationId
    }
  }

  return @($tabs)
}

function Select-TermhubTab([int64]$windowHandle, [int]$tabIndex) {
  $items = @(Get-TermhubTabElements $windowHandle)

  if ($items.Count -eq 0) {
    if ($tabIndex -eq 1) {
      return Set-TermhubForeground $windowHandle
    }

    throw "Session not found"
  }

  if ($tabIndex -lt 1 -or $tabIndex -gt $items.Count) {
    throw "Session not found"
  }

  [void](Set-TermhubForeground $windowHandle)
  $target = $items[$tabIndex - 1]

  try {
    $pattern = $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($null -ne $pattern) {
      $pattern.Select()
      Start-Sleep -Milliseconds 120
      return $true
    }
  } catch { }

  try {
    $pattern = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $pattern) {
      $pattern.Invoke()
      Start-Sleep -Milliseconds 120
      return $true
    }
  } catch { }

  try {
    $target.SetFocus()
    Start-Sleep -Milliseconds 120
    return $true
  } catch { }

  return $false
}

function Add-TermhubTextCandidate([System.Collections.Generic.List[string]]$candidates, [string]$value) {
  $text = ConvertTo-TermhubText $value
  if ($null -eq $text) {
    return
  }

  if (-not $candidates.Contains($text)) {
    $candidates.Add($text)
  }
}

function Get-TermhubTextFromElement([System.Windows.Automation.AutomationElement]$element) {
  if ($null -eq $element) {
    return $null
  }

  $candidates = New-Object 'System.Collections.Generic.List[string]'

  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -ne $pattern) {
      Add-TermhubTextCandidate $candidates ($pattern.DocumentRange.GetText(-1))
    }
  } catch { }

  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $pattern) {
      Add-TermhubTextCandidate $candidates ($pattern.Current.Value)
    }
  } catch { }

  try {
    Add-TermhubTextCandidate $candidates $element.Current.Name
  } catch { }

  if ($candidates.Count -eq 0) {
    return $null
  }

  return ($candidates | Sort-Object { $_.Length } -Descending | Select-Object -First 1)
}

function Get-TermhubTextFromHandle([int64]$windowHandle) {
  $root = Find-TermhubWindowElementByHandle $windowHandle
  if ($null -eq $root) {
    return $null
  }

  $candidates = New-Object 'System.Collections.Generic.List[string]'
  Add-TermhubTextCandidate $candidates (Get-TermhubTextFromElement $root)

  $elements = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  foreach ($element in $elements) {
    Add-TermhubTextCandidate $candidates (Get-TermhubTextFromElement $element)
  }

  if ($candidates.Count -eq 0) {
    return $null
  }

  return ($candidates | Sort-Object { $_.Length } -Descending | Select-Object -First 1)
}

${includeSendKeys ? `
function Escape-TermhubSendKeys([string]$value) {
  if ($null -eq $value) {
    return ''
  }

  $builder = New-Object System.Text.StringBuilder

  foreach ($char in $value.ToCharArray()) {
    switch ($char) {
      '+' { [void]$builder.Append('{+}') }
      '^' { [void]$builder.Append('{^}') }
      '%' { [void]$builder.Append('{%}') }
      '~' { [void]$builder.Append('{~}') }
      '(' { [void]$builder.Append('{(}') }
      ')' { [void]$builder.Append('{)}') }
      '[' { [void]$builder.Append('{[}') }
      ']' { [void]$builder.Append('{]}') }
      '{' { [void]$builder.Append('{{}') }
      '}' { [void]$builder.Append('{}}') }
      "\`r" { }
      "\`n" { [void]$builder.Append('~') }
      default { [void]$builder.Append($char) }
    }
  }

  return $builder.ToString()
}

function Send-TermhubKeys([string]$keys) {
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds 120
}

function Send-TermhubInput([string]$text, [bool]$appendEnter) {
  $keys = Escape-TermhubSendKeys $text
  if ($appendEnter) {
    $keys += '~'
  }

  Send-TermhubKeys $keys
}
` : ""}
`;
}

export function buildPowerShellJsonCommand(body, options = {}) {
  return `${getWin32Prelude(options)}
try {
${body}
} catch {
  $message = if ($_.Exception -and $_.Exception.Message) {
    $_.Exception.Message
  } else {
    ($_ | Out-String).Trim()
  }

  Write-Error $message
  exit 1
}
`;
}

export function getWin32ErrorMessage(error) {
  if (error instanceof CLIError) {
    if (typeof error.details === "string" && error.details) {
      return `${error.message}\n${error.details}`;
    }

    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

export function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(
          new CLIError("powershell.exe is not available", {
            code: "POWERSHELL_NOT_FOUND",
            exitCode: 5,
          }),
        );
        return;
      }

      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }

      reject(
        new CLIError("PowerShell execution failed", {
          code: "POWERSHELL_FAILED",
          exitCode: 5,
          details: stderr.trim() || stdout.trim() || "PowerShell execution failed",
        }),
      );
    });
  });
}

export async function runPowerShellJson(script) {
  const raw = await runPowerShell(script);
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new CLIError("PowerShell returned invalid JSON", {
      code: "POWERSHELL_INVALID_JSON",
      exitCode: 5,
      details: trimmed,
    });
  }
}

export function mapWin32Error(message, options = {}) {
  const displayName = options.displayName ?? "Windows terminal app";

  if (message.includes("Session not found")) {
    return new CLIError("Session not found", {
      code: "SESSION_NOT_FOUND",
      exitCode: 3,
      details: message,
    });
  }

  if (message.includes("powershell.exe is not available") || message.includes("POWERSHELL_NOT_FOUND")) {
    return new CLIError("powershell.exe is not available", {
      code: "POWERSHELL_NOT_FOUND",
      exitCode: 5,
      details: message,
    });
  }

  if (message.includes("UIAutomationClient") || message.includes("AutomationElement")) {
    return new CLIError(`UI Automation is not available for ${displayName}`, {
      code: "UI_AUTOMATION_UNAVAILABLE",
      exitCode: 5,
      details: message,
    });
  }

  if (message.includes("SendKeys")) {
    return new CLIError(`Keyboard automation failed for ${displayName}`, {
      code: "SEND_KEYS_FAILED",
      exitCode: 5,
      details: message,
    });
  }

  if (message.includes("is not running")) {
    return new CLIError(`${displayName} is not running`, {
      code: "APP_NOT_RUNNING",
      exitCode: 5,
      details: message,
    });
  }

  if (message.includes("POWERSHELL_INVALID_JSON")) {
    return new CLIError("PowerShell returned invalid JSON", {
      code: "POWERSHELL_INVALID_JSON",
      exitCode: 5,
      details: message,
    });
  }

  return new CLIError("PowerShell execution failed", {
    code: "POWERSHELL_FAILED",
    exitCode: 5,
    details: message,
  });
}
