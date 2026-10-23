import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareWindowsRuntime } from '../lib/overlay.js';
import { artifactsDir } from './paths.mjs';

const directory=path.join(artifactsDir,'visual-'+Date.now());
await fs.mkdir(directory,{recursive:true});
const script=await prepareWindowsRuntime(directory);
await fs.writeFile(path.join(artifactsDir,'current-visual-preview.json'),JSON.stringify({directory,script}));
const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./overlay-render.ps1',import.meta.url)),'-SourcePath',path.join(directory,'windows-engine/scripts/windows-takeover.cs'),'-ArtifactDirectory',directory],{windowsHide:true,stdio:'inherit'});
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
