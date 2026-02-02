/**
 * Types Tests - FileSizeError and formatFileSize
 */

import { describe, it, expect } from 'vitest';
import { formatFileSize, FileSizeError, MAX_FILE_SIZE, MAX_FILE_SIZE_DISPLAY } from '../index';

describe('formatFileSize', () => {
  it('formats 0 bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(5.5 * 1024 * 1024)).toBe('5.5 MB');
  });

  it('formats gigabytes', () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatFileSize(2.25 * 1024 * 1024 * 1024)).toBe('2.25 GB');
  });

  it('formats terabytes', () => {
    expect(formatFileSize(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
  });
});

describe('FileSizeError', () => {
  it('has correct name', () => {
    const error = new FileSizeError(30 * 1024 * 1024 * 1024);
    expect(error.name).toBe('FileSizeError');
  });

  it('includes formatted file size in message', () => {
    const error = new FileSizeError(30 * 1024 * 1024 * 1024);
    expect(error.message).toContain('30 GB');
  });

  it('includes max size in message', () => {
    const error = new FileSizeError(30 * 1024 * 1024 * 1024);
    expect(error.message).toContain(MAX_FILE_SIZE_DISPLAY);
  });

  it('is an instance of Error', () => {
    const error = new FileSizeError(100);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('MAX_FILE_SIZE', () => {
  it('is 25GB', () => {
    expect(MAX_FILE_SIZE).toBe(25 * 1024 * 1024 * 1024);
  });
});

describe('MAX_FILE_SIZE_DISPLAY', () => {
  it('is human readable', () => {
    expect(MAX_FILE_SIZE_DISPLAY).toBe('25 GB');
  });
});
