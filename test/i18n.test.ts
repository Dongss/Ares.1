import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { brandName, brandSlogan, brandTitle } from '../src/brand.js';
import { homePaths, initHome, loadConfig } from '../src/config/load.js';
import { join, lang, langOfLocale, localeTag, setLang, t } from '../src/i18n.js';
import { tmpDir, writeFile } from './helpers.js';

afterEach(() => setLang('zh'));

describe('i18n', () => {
  it('picks the text of the language in use, Chinese by default', () => {
    expect(lang()).toBe('zh');
    expect(t({ zh: '加载中…', en: 'Loading…' })).toBe('加载中…');
    setLang('en');
    expect(t({ zh: '加载中…', en: 'Loading…' })).toBe('Loading…');
    expect(localeTag()).toBe('en');
    expect(localeTag('zh')).toBe('zh-CN');
  });

  it('joins lists the way each language does', () => {
    expect(join(['a', 'b'])).toBe('a、b');
    setLang('en');
    expect(join(['a', 'b'])).toBe('a, b');
  });

  it('reads the language a system locale asks for', () => {
    expect(langOfLocale('zh_CN.UTF-8')).toBe('zh');
    expect(langOfLocale('zh-Hans-CN')).toBe('zh');
    expect(langOfLocale('zh')).toBe('zh');
    expect(langOfLocale('en_US.UTF-8')).toBe('en');
    expect(langOfLocale('ja-JP')).toBe('en');
    expect(langOfLocale('C')).toBeNull();
    expect(langOfLocale(undefined)).toBeNull();
    expect(langOfLocale('')).toBeNull();
  });

  it('names the project in each language', () => {
    expect(brandTitle()).toBe('战神一号 · 自举永动机');
    setLang('en');
    expect(brandName()).toBe('Ares.1');
    expect(brandSlogan()).toBe('Self-bootstrapping perpetual motion machine');
    expect(brandTitle()).toBe('Ares.1 · Self-bootstrapping perpetual motion machine');
  });
});

describe('config.yaml language', () => {
  it('defaults to Chinese and is written into a new config.yaml', () => {
    const paths = homePaths(tmpDir('ares1-lang-'));
    initHome(paths);
    expect(readFileSync(paths.configFile, 'utf8')).toMatch(/^language: zh$/m);
    expect(loadConfig(paths, ['claude-code']).master.language).toBe('zh');
  });

  it('writes the default files in the language in use on first start', () => {
    setLang('en');
    const paths = homePaths(tmpDir('ares1-lang-'));
    initHome(paths);
    const source = readFileSync(paths.configFile, 'utf8');
    expect(source).toMatch(/^language: en$/m);
    expect(source).not.toMatch(/[一-鿿]/);
    expect(readFileSync(paths.agentsFile, 'utf8')).not.toMatch(/[一-鿿]/);
  });

  it('switches the language when config.yaml is loaded, so problems are reported in it', () => {
    const paths = homePaths(tmpDir('ares1-lang-'));
    initHome(paths);
    writeFile(paths.configFile, 'language: en\nupgarde: { auto: true }\n');
    const cfg = loadConfig(paths, ['claude-code']);
    expect(cfg.master.language).toBe('en');
    expect(lang()).toBe('en');
    expect(cfg.warnings['config.yaml']?.[0]).not.toMatch(/[一-鿿]/);

    writeFile(paths.configFile, 'port: 4870\n');
    expect(loadConfig(paths, ['claude-code']).master.language).toBe('zh');
    expect(lang()).toBe('zh');
  });

  it('rejects an unknown language', () => {
    const paths = homePaths(tmpDir('ares1-lang-'));
    initHome(paths);
    writeFile(paths.configFile, 'language: fr\n');
    expect(() => loadConfig(paths, ['claude-code'])).toThrow(/language/);
  });
});
