'use strict';

// Bakes uninstall-ephemera.ps1 into a single, self-contained, double-clickable
// "Uninstall Ephemera.cmd". The .cmd extracts the embedded PowerShell to %TEMP%
// and runs it from there, so the uninstaller can delete its own install folder.
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const ps = fs.readFileSync(path.join(dir, 'uninstall-ephemera.ps1'), 'utf8');

const MARKER = '#:::PSSTART:::';

// Batch header: read this file, slice everything after the marker, write it to a
// temp .ps1, and launch it. The PowerShell script then self-elevates.
const header = [
  '@echo off',
  'setlocal',
  'rem  Ephemera full uninstaller - self-contained launcher (auto-generated).',
  'set "PS=%TEMP%\\Ephemera-Uninstall.ps1"',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "$raw=[IO.File]::ReadAllText(\'%~f0\'); $i=$raw.LastIndexOf(\'' + MARKER + '\'); if($i -lt 0){ exit 1 }; $body=$raw.Substring($i + ' + MARKER.length + '); [IO.File]::WriteAllText($env:TEMP + \'\\Ephemera-Uninstall.ps1\', $body, (New-Object Text.UTF8Encoding($false))); Start-Process powershell -ArgumentList \'-NoProfile\',\'-ExecutionPolicy\',\'Bypass\',\'-File\',($env:TEMP + \'\\Ephemera-Uninstall.ps1\')"',
  'exit /b',
  MARKER,
  '',
].join('\r\n');

const out = header + ps.replace(/\r?\n/g, '\r\n');
const outPath = path.join(dir, 'Uninstall Ephemera.cmd');
fs.writeFileSync(outPath, out, 'latin1');
console.log('Wrote ' + outPath + ' (' + out.length + ' bytes)');
