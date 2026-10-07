import { describe, expect, it } from 'vitest';
import { parseDeviceCreds } from './token';

// Dummy fixture constructed by this test, not copied from any real device.
// Shape mirrors tokenCoreSE.json: a top-level JSON object with the single key
// "DeviceManager.device" holding base64 of an inner JSON blob. The fields we
// care about are inner.udid and inner.credentials.password; the rest
// (token, dnsFormat, certificate, ...) are present on a real device but are
// not needed by the parser, so the fixture omits them.
const DUMMY_UDID = 'U1.00000000-0000-4000-8000-000000000000.hma201.deadbeefcafef00dfeedfacedeadbeefcafef00dfeedfacedeadbeefcafe0000';
const DUMMY_PASSWORD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';

function makeFixture(udid: string, password: string, extra: Record<string, unknown> = {}): string {
  const inner = {
    token: { accessToken: 'unused-in-this-test' },
    udid,
    credentials: { certificateSerialNumber: 123, password, ...extra },
  };
  const b64 = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
  return JSON.stringify({ 'DeviceManager.device': b64 });
}

describe('parseDeviceCreds', () => {
  it('extracts udid and password from a well-formed tokenCoreSE.json blob', () => {
    const fileText = makeFixture(DUMMY_UDID, DUMMY_PASSWORD);
    expect(parseDeviceCreds(fileText)).toEqual({ udid: DUMMY_UDID, password: DUMMY_PASSWORD });
  });

  it('ignores unrelated fields in the decoded blob', () => {
    const fileText = makeFixture(DUMMY_UDID, DUMMY_PASSWORD, { certificate: 'MIIU...lots-of-base64' });
    expect(parseDeviceCreds(fileText)).toEqual({ udid: DUMMY_UDID, password: DUMMY_PASSWORD });
  });

  it('throws a clear error when the top-level key is missing', () => {
    expect(() => parseDeviceCreds(JSON.stringify({ somethingElse: 'x' }))).toThrow(/DeviceManager\.device/);
  });

  it('throws a clear error when the file is not JSON', () => {
    expect(() => parseDeviceCreds('not json at all')).toThrow();
  });

  it('throws when the decoded blob is missing udid or password', () => {
    const inner = { credentials: { password: DUMMY_PASSWORD } }; // no udid
    const b64 = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
    const fileText = JSON.stringify({ 'DeviceManager.device': b64 });
    expect(() => parseDeviceCreds(fileText)).toThrow(/udid/);
  });
});
