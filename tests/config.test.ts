import { describe, expect, it } from 'vitest';
import { applicationConfig } from '../src/config.js';

describe('application configuration', () => {
  it('uses a loopback host for local development and resolves the data directory', () => {
    const config = applicationConfig({ NODE_ENV: 'development', APP_DATA_DIR: './tmp/anc-data' });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.dataDirectory).toMatch(/tmp\/anc-data$/u);
  });

  it('keeps production binding explicit and validates ports', () => {
    expect(applicationConfig({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '8080' })).toMatchObject({
      environment: 'production', host: '127.0.0.1', port: 8080,
    });
    expect(() => applicationConfig({ PORT: '0' })).toThrow(/between 1 and 65535/iu);
    expect(() => applicationConfig({ PORT: 'not-a-port' })).toThrow(/between 1 and 65535/iu);
    expect(() => applicationConfig({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/iu);
  });
});
