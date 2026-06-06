/**
 * ARM barrel shifter.
 *
 * Most ARM data-processing instructions fold a shift into operand 2. The shifter produces
 * both a shifted value AND a carry-out, which (for logical ops with the S bit) becomes the
 * new C flag. Getting the carry-out edge cases right (LSR #0 == LSR #32, ASR #0 == ASR #32,
 * ROR #0 == RRX) is essential — a lot of subtle game bugs trace back to these.
 */

export const ShiftType = { LSL: 0, LSR: 1, ASR: 2, ROR: 3 } as const;
export type ShiftType = (typeof ShiftType)[keyof typeof ShiftType];

export interface ShiftResult { value: number; carry: boolean; }

/**
 * Apply an immediate-amount shift (amount encoded in the instruction, 0..31).
 * `carryIn` is the current CPSR C flag, used by the amount==0 special cases.
 */
export function shiftImm(type: ShiftType, value: number, amount: number, carryIn: boolean): ShiftResult {
  value = value | 0;
  switch (type) {
    case ShiftType.LSL:
      if (amount === 0) return { value, carry: carryIn };
      return { value: (value << amount) | 0, carry: ((value >>> (32 - amount)) & 1) !== 0 };
    case ShiftType.LSR:
      // LSR #0 is interpreted as LSR #32.
      if (amount === 0) return { value: 0, carry: (value & 0x80000000) !== 0 };
      return { value: (value >>> amount) | 0, carry: ((value >>> (amount - 1)) & 1) !== 0 };
    case ShiftType.ASR:
      // ASR #0 is interpreted as ASR #32.
      if (amount === 0) {
        const c = (value & 0x80000000) !== 0;
        return { value: c ? -1 : 0, carry: c };
      }
      return { value: (value >> amount) | 0, carry: ((value >> (amount - 1)) & 1) !== 0 };
    case ShiftType.ROR:
      // ROR #0 is RRX: 33-bit rotate through carry.
      if (amount === 0) {
        const cOut = (value & 1) !== 0;
        const v = ((carryIn ? 0x80000000 : 0) | ((value >>> 1) & 0x7fffffff)) | 0;
        return { value: v, carry: cOut };
      }
      amount &= 31;
      if (amount === 0) return { value, carry: (value & 0x80000000) !== 0 };
      return { value: ((value >>> amount) | (value << (32 - amount))) | 0, carry: ((value >>> (amount - 1)) & 1) !== 0 };
  }
}

/**
 * Apply a register-amount shift (amount taken from a register's low byte, 0..255).
 * Register-specified shifts have different amount==0 and amount>=32 behavior than immediate.
 */
export function shiftReg(type: ShiftType, value: number, amount: number, carryIn: boolean): ShiftResult {
  value = value | 0;
  amount &= 0xff;
  if (amount === 0) return { value, carry: carryIn };
  switch (type) {
    case ShiftType.LSL:
      if (amount < 32) return { value: (value << amount) | 0, carry: ((value >>> (32 - amount)) & 1) !== 0 };
      if (amount === 32) return { value: 0, carry: (value & 1) !== 0 };
      return { value: 0, carry: false };
    case ShiftType.LSR:
      if (amount < 32) return { value: (value >>> amount) | 0, carry: ((value >>> (amount - 1)) & 1) !== 0 };
      if (amount === 32) return { value: 0, carry: (value & 0x80000000) !== 0 };
      return { value: 0, carry: false };
    case ShiftType.ASR:
      if (amount < 32) return { value: (value >> amount) | 0, carry: ((value >> (amount - 1)) & 1) !== 0 };
      { const c = (value & 0x80000000) !== 0; return { value: c ? -1 : 0, carry: c }; }
    case ShiftType.ROR: {
      const a = amount & 31;
      if (a === 0) return { value, carry: (value & 0x80000000) !== 0 };
      return { value: ((value >>> a) | (value << (32 - a))) | 0, carry: ((value >>> (a - 1)) & 1) !== 0 };
    }
  }
}
