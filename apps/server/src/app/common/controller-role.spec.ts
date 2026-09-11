import { describe, expect, it } from 'vitest';
import {
  ControllerRoleError,
  resolveControllerRole,
} from './controller-role';

describe('resolveControllerRole', () => {
  it('accepts the two roles, however they are cased or padded', () => {
    expect(resolveControllerRole('leader', true)).toBe('leader');
    expect(resolveControllerRole('follower', true)).toBe('follower');
    expect(resolveControllerRole('  FOLLOWER  ', true)).toBe('follower');
  });

  it('refuses to guess when the server drives real hardware', () => {
    // The dangerous case: a second box deployed without the variable would
    // otherwise start heartbeating and be obeyed alongside the first.
    expect(() => resolveControllerRole(undefined, true)).toThrow(ControllerRoleError);
    expect(() => resolveControllerRole('', true)).toThrow(ControllerRoleError);
  });

  it('defaults to leader only for the fake driver, where nothing can be commanded', () => {
    expect(resolveControllerRole(undefined, false)).toBe('leader');
  });

  it('rejects a typo rather than falling back', () => {
    // "follwer" silently becoming a leader is the whole hazard.
    expect(() => resolveControllerRole('follwer', false)).toThrow(ControllerRoleError);
    expect(() => resolveControllerRole('primary', true)).toThrow(ControllerRoleError);
  });
});
