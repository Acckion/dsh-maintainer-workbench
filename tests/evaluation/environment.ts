import { join } from 'node:path';
/** Only process-launch essentials may cross into the fixture process. */
export function fixtureEnvironment(source: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP'];
  const env = Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  return { ...env, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'empty.gitconfig'), GITHUB_TOKEN: 'deterministic-fixture-only', GH_TOKEN: '', MAINTAINER_API_KEY: 'deterministic-fixture-only', DEEPSEEK_API_KEY: 'deterministic-fixture-only', MAINTAINER_BASE_URL: 'http://127.0.0.1:9', DSH_HOME: join(scratch, 'dsh'), MAINTAINER_DATA_DIR: join(scratch, 'maintainer') };
}
