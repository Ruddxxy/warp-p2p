import { useState, useRef, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { mapErrorToAppError } from '../types';

interface CodeInputProps {
  onSubmit: (code: string) => void;
  disabled?: boolean;
  error?: string | null;
}

export function CodeInput({ onSubmit, disabled, error }: CodeInputProps) {
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const structuredError = useMemo(
    () => (error ? mapErrorToAppError(error) : null),
    [error]
  );

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, '').slice(-1);

    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    if (newDigits.every((d) => d !== '')) {
      const code = `${newDigits[0]}${newDigits[1]}${newDigits[2]}-${newDigits[3]}${newDigits[4]}${newDigits[5]}`;
      onSubmit(code);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);

    if (pasted.length === 6) {
      const newDigits = pasted.split('');
      setDigits(newDigits);
      inputRefs.current[5]?.focus();

      const code = `${newDigits[0]}${newDigits[1]}${newDigits[2]}-${newDigits[3]}${newDigits[4]}${newDigits[5]}`;
      onSubmit(code);
    }
  };

  return (
    <motion.div
      className="w-full max-w-md bg-surface border border-border rounded-2xl p-6 md:p-8"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="text-center mb-8">
        <h2 className="text-text text-xl font-semibold mb-2">Enter code</h2>
        <p className="text-text-muted text-sm">Enter the 6-digit code from the sender</p>
      </div>

      {/* Code input boxes */}
      <div className="flex items-center justify-center gap-3 mb-6" onPaste={handlePaste}>
        {digits.map((digit, i) => (
          <div key={i} className="flex items-center">
            <input
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              disabled={disabled}
              aria-label={`Digit ${i + 1}`}
              className={`
                w-12 h-14 md:w-14 md:h-16 text-center text-2xl md:text-3xl font-mono font-bold
                bg-bg border rounded-lg
                transition-all duration-200
                ${error ? 'border-error focus:border-error' : 'border-border focus:border-primary'}
                text-text
                disabled:opacity-50 disabled:cursor-not-allowed
                placeholder:text-text-faint/30
              `}
              placeholder="0"
            />
            {i === 2 && <span className="text-text-faint text-3xl font-bold mx-2">-</span>}
          </div>
        ))}
      </div>

      {/* Error message */}
      {structuredError && (
        <motion.div
          className="mb-4 py-3 px-4 bg-error-muted border border-error/30 rounded-lg"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <p className="text-error text-sm text-center font-medium">{structuredError.message}</p>
          <p className="text-text-faint text-xs text-center mt-1">{structuredError.suggestion}</p>
        </motion.div>
      )}

      {/* Status */}
      {disabled && (
        <motion.div
          className="flex items-center justify-center gap-2 py-2"
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        >
          <div className="w-2 h-2 rounded-full bg-primary" />
          <span className="text-text-muted text-sm">Connecting...</span>
        </motion.div>
      )}
    </motion.div>
  );
}
