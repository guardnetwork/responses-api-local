import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const commit = '091ff27f31285ec4fd1dd5823b44f7f51fb8f48b';
const repository = 'https://github.com/router-for-me/CLIProxyAPI.git';
const archiveSha256 = '83795a296dbcb3ea5c69e7dadb1ef08a0284ccff1add89c999e90298dba9e8d6';

function verifyArchive(path) {
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== archiveSha256) {
    throw Error('Pinned CLIProxyAPI archive checksum mismatch');
  }
}

export function extractProxySource(cache, destination) {
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, `CLIProxyAPI-${commit}.tar`);
  if (!existsSync(archive)) {
    const temporary = mkdtempSync(join(cache, 'fetch-'));
    try {
      const checkout = join(temporary, 'source.git');
      const download = join(temporary, 'source.tar');
      const env = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(),
        GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      };
      const git = args => execFileSync('/usr/bin/git', ['-c', 'credential.helper=', '-c', 'http.extraheader=', ...args],
        { env, stdio: 'inherit' });
      git(['init', '--bare', '--quiet', checkout]);
      git(['-C', checkout, 'fetch', '--no-tags', '--quiet', '--depth=1', repository, commit]);
      git(['-C', checkout, 'archive', '--format=tar', `--output=${download}`, commit]);
      verifyArchive(download);
      renameSync(download, archive);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  verifyArchive(archive);
  execFileSync('/usr/bin/tar', ['-xf', archive, '-C', destination], { stdio: 'inherit' });
}
