/// <reference types="node" />
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateConfig } from './validate.js';

export function loadConfig(path: string) {
  const json = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
  try {
    const input = json(path);
    if (!input || typeof input !== 'object' || !('directoryFile' in input) || !('limitsFile' in input)
      || typeof input.directoryFile !== 'string' || typeof input.limitsFile !== 'string') {
      throw new Error('Invalid configuration');
    }
    const directory = json(resolve(dirname(path), input.directoryFile));
    const limits = json(resolve(dirname(path), input.limitsFile));
    return validateConfig(input, directory, limits, secretPath => {
      accessSync(secretPath, constants.R_OK);
      return statSync(secretPath).isFile();
    });
  } catch {
    // JSON and filesystem errors may contain credentials or sensitive source text.
    throw new Error('Invalid configuration');
  }
}
