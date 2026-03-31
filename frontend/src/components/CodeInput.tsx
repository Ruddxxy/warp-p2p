import { useState, useRef, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { mapErrorToAppError } from "../types";

interface CodeInputProps {
  onSubmit: (code: string) => void;
  disabled?: boolean;
  error?: string | null;
}

export function CodeInput({ onSubmit, disabled, error }: CodeInputProps) {
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const structuredError = useMemo(
    () => (error ? mapErrorToAppError(error) : null),
    [error],
  );

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    if (newDigits.every((d) => d !== "")) {
      const code = `${newDigits[0]}${newDigits[1]}${newDigits[2]}-${newDigits[3]}${newDigits[4]}${newDigits[5]}`;
      onSubmit(code);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData
      .getData("text")
      .replace(/\D/g, "")
      .slice(0, 6);

    if (pasted.length === 6) {
      const newDigits = pasted.split("");
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
      {/* Header */}
      <div className="text-center mb-8">
        <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#6366F1"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>
        <h2 className="text-text text-xl font-semibold">Enter code</h2>
        <p className="text-text-muted text-sm mt-2">
          Enter the 6-digit code from the sender
        </p>
      </div>

      {/* Code input boxes */}
      <div
        className="flex items-center justify-center gap-2 sm:gap-3 mb-6"
        onPaste={handlePaste}
      >
        {digits.map((digit, i) => (
          <div key={i} className="flex items-center">
            <input
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              disabled={disabled}
              aria-label={`Digit ${i + 1} of 6`}
              className={`
                w-11 h-14 sm:w-14 sm:h-16 text-center text-2xl sm:text-3xl font-mono font-bold
                bg-bg border-2 rounded-xl
                transition-all duration-200
                ${
                  error
                    ? "border-error/50 focus:border-error"
                    : digit
                      ? "border-primary/40 focus:border-primary"
                      : "border-border focus:border-primary"
                }
                text-text
                disabled:opacity-40 disabled:cursor-not-allowed
                placeholder:text-text-faint/20
                focus:ring-2 focus:ring-primary/20
              `}
              placeholder="0"
            />
            {i === 2 && (
              <span
                className="text-text-faint text-2xl sm:text-3xl font-bold mx-1.5 sm:mx-2 select-none"
                aria-hidden="true"
              >
                -
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Error message */}
      {structuredError && (
        <motion.div
          className="mb-4 py-3 px-4 bg-error-muted border border-error/30 rounded-xl"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <p
            className="text-error text-sm text-center font-medium"
            role="alert"
          >
            {structuredError.message}
          </p>
          <p className="text-text-faint text-xs text-center mt-1">
            {structuredError.suggestion}
          </p>
        </motion.div>
      )}

      {/* Connecting status */}
      {disabled && (
        <motion.div
          className="flex items-center justify-center gap-2.5 py-2"
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
