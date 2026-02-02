import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';

interface CodeInputProps {
  onSubmit: (code: string) => void;
  disabled?: boolean;
  error?: string | null;
}

export function CodeInput({ onSubmit, disabled, error }: CodeInputProps) {
  const [digits, setDigits] = useState(['', '', '', '']);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleChange = (index: number, value: string) => {
    // Only allow digits
    const digit = value.replace(/\D/g, '').slice(-1);

    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    // Auto-advance to next field
    if (digit && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when complete
    if (newDigits.every((d) => d !== '')) {
      const code = `${newDigits[0]}${newDigits[1]}-${newDigits[2]}${newDigits[3]}`;
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
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4);

    if (pasted.length === 4) {
      const newDigits = pasted.split('');
      setDigits(newDigits);
      inputRefs.current[3]?.focus();

      const code = `${newDigits[0]}${newDigits[1]}-${newDigits[2]}${newDigits[3]}`;
      onSubmit(code);
    }
  };

  return (
    <motion.div
      className="relative w-full max-w-md glass-panel glass-glow rounded-2xl p-8"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="text-center mb-8">
        <h2 className="text-[#00ff41] text-xl font-medium mb-2 text-glow">Enter Code</h2>
        <p className="text-[#00ff41]/50 text-sm">Enter the 4-digit code from the sender</p>
      </div>

      {/* Code input boxes */}
      <div className="flex items-center justify-center gap-3 mb-6" onPaste={handlePaste}>
        {digits.map((digit, i) => (
          <motion.div key={i} className="flex items-center">
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
              className={`
                w-14 h-16 text-center text-3xl font-mono font-bold
                glass-input rounded-lg outline-none
                transition-all duration-200
                ${error ? 'border-red-500/70 focus:border-red-500' : 'focus:border-[#00ff41]'}
                text-[#00ff41] text-glow
                disabled:opacity-50 disabled:cursor-not-allowed
                placeholder:text-[#00ff41]/20
              `}
              placeholder="0"
            />
            {i === 1 && <span className="text-[#00ff41] text-3xl font-bold mx-2 text-glow">-</span>}
          </motion.div>
        ))}
      </div>

      {/* Error message */}
      {error && (
        <motion.div
          className="mb-4 py-2 px-4 glass-panel border-red-500/30 bg-red-500/10 rounded-lg"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <p className="text-red-400 text-sm text-center">{error}</p>
        </motion.div>
      )}

      {/* Status */}
      {disabled && (
        <motion.div
          className="flex items-center justify-center gap-2 py-2"
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        >
          <motion.div
            className="w-2 h-2 rounded-full bg-[#00ff41]"
            animate={{
              boxShadow: [
                '0 0 4px rgba(0, 255, 65, 0.5)',
                '0 0 12px rgba(0, 255, 65, 0.8)',
                '0 0 4px rgba(0, 255, 65, 0.5)'
              ]
            }}
            transition={{ duration: 1, repeat: Infinity }}
          />
          <span className="text-[#00ff41]/80 text-sm">Connecting...</span>
        </motion.div>
      )}

      {/* Decorative corners */}
      <div className="absolute top-2 left-2 w-5 h-5 border-l-2 border-t-2 border-[#00ff41]/40 rounded-tl pointer-events-none" />
      <div className="absolute top-2 right-2 w-5 h-5 border-r-2 border-t-2 border-[#00ff41]/40 rounded-tr pointer-events-none" />
      <div className="absolute bottom-2 left-2 w-5 h-5 border-l-2 border-b-2 border-[#00ff41]/40 rounded-bl pointer-events-none" />
      <div className="absolute bottom-2 right-2 w-5 h-5 border-r-2 border-b-2 border-[#00ff41]/40 rounded-br pointer-events-none" />
    </motion.div>
  );
}
