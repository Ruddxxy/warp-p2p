/**
 * Types Tests - FileSizeError, formatFileSize, and MVP utilities
 */

import { describe, it, expect } from 'vitest';
import {
  formatFileSize,
  FileSizeError,
  MAX_FILE_SIZE,
  MAX_FILE_SIZE_DISPLAY,
  getFileCategory,
  getEstimatedTransferTime,
  mapErrorToAppError,
} from '../index';

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

describe('getFileCategory', () => {
  it('detects image files', () => {
    expect(getFileCategory('photo.jpg')).toBe('image');
    expect(getFileCategory('icon.PNG')).toBe('image');
    expect(getFileCategory('graphic.svg')).toBe('image');
  });

  it('detects video files', () => {
    expect(getFileCategory('clip.mp4')).toBe('video');
    expect(getFileCategory('movie.mkv')).toBe('video');
  });

  it('detects audio files', () => {
    expect(getFileCategory('song.mp3')).toBe('audio');
    expect(getFileCategory('track.flac')).toBe('audio');
  });

  it('detects document files', () => {
    expect(getFileCategory('report.pdf')).toBe('document');
    expect(getFileCategory('data.csv')).toBe('document');
    expect(getFileCategory('notes.txt')).toBe('document');
  });

  it('detects archive files', () => {
    expect(getFileCategory('backup.zip')).toBe('archive');
    expect(getFileCategory('bundle.tar')).toBe('archive');
  });

  it('detects code files', () => {
    expect(getFileCategory('app.tsx')).toBe('code');
    expect(getFileCategory('main.py')).toBe('code');
    expect(getFileCategory('styles.css')).toBe('code');
  });

  it('returns other for unknown extensions', () => {
    expect(getFileCategory('file.xyz')).toBe('other');
    expect(getFileCategory('noext')).toBe('other');
  });
});

describe('getEstimatedTransferTime', () => {
  it('returns instant for 0 bytes', () => {
    expect(getEstimatedTransferTime(0)).toBe('instant');
  });

  it('returns < 1 sec for small files', () => {
    expect(getEstimatedTransferTime(100_000)).toBe('< 1 sec');
  });

  it('returns seconds for medium files', () => {
    const result = getEstimatedTransferTime(10 * 1024 * 1024);
    expect(result).toMatch(/~\d+ sec/);
  });

  it('returns minutes for large files', () => {
    const result = getEstimatedTransferTime(500 * 1024 * 1024);
    expect(result).toMatch(/~\d+ min/);
  });
});

describe('mapErrorToAppError', () => {
  it('maps wrong code error', () => {
    const err = mapErrorToAppError('Handshake failed - wrong code');
    expect(err.code).toBe('WRONG_CODE');
    expect(err.recoverable).toBe(true);
    expect(err.suggestion).toBeTruthy();
  });

  it('maps room expired error', () => {
    const err = mapErrorToAppError('Room expired after 10 minutes');
    expect(err.code).toBe('ROOM_EXPIRED');
  });

  it('maps peer disconnected error', () => {
    const err = mapErrorToAppError('Peer disconnected during transfer');
    expect(err.code).toBe('PEER_DISCONNECTED');
  });

  it('maps connection failed error', () => {
    const err = mapErrorToAppError('Peer connection failed');
    expect(err.code).toBe('CONNECTION_FAILED');
  });

  it('maps data channel error', () => {
    const err = mapErrorToAppError('Data channel error');
    expect(err.code).toBe('CHANNEL_ERROR');
  });

  it('maps connection timeout error', () => {
    const err = mapErrorToAppError('Connection timeout: server did not respond within 10 seconds');
    expect(err.code).toBe('CONNECTION_TIMEOUT');
    expect(err.recoverable).toBe(true);
    expect(err.suggestion).toBeTruthy();
  });

  it('maps server unreachable error', () => {
    const err = mapErrorToAppError('Could not connect to server. Check your internet connection.');
    expect(err.code).toBe('SERVER_UNREACHABLE');
    expect(err.recoverable).toBe(true);
    expect(err.suggestion).toBeTruthy();
  });

  it('maps connection rejected error', () => {
    const err = mapErrorToAppError('Connection closed before server acknowledged the connection');
    expect(err.code).toBe('CONNECTION_REJECTED');
    expect(err.recoverable).toBe(true);
    expect(err.suggestion).toBeTruthy();
  });

  it('maps signaling error', () => {
    const err = mapErrorToAppError('Signaling error');
    expect(err.code).toBe('SIGNALING_ERROR');
  });

  it('maps decryption error', () => {
    const err = mapErrorToAppError('Decryption failed - possible tampering');
    expect(err.code).toBe('DECRYPTION_FAILED');
  });

  it('maps integrity check error', () => {
    const err = mapErrorToAppError('File integrity check failed - hash mismatch');
    expect(err.code).toBe('INTEGRITY_FAILED');
  });

  it('maps hash verification error', () => {
    const err = mapErrorToAppError('Receiver reported hash verification failed');
    expect(err.code).toBe('HASH_FAILED');
  });

  it('returns unknown for unrecognized errors', () => {
    const err = mapErrorToAppError('Something completely unexpected happened');
    expect(err.code).toBe('UNKNOWN');
    expect(err.recoverable).toBe(true);
  });
});
