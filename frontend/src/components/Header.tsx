import { motion } from 'framer-motion';

export function Header() {
  return (
    <motion.header
      className="fixed top-0 left-0 right-0 z-50 glass-header"
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      transition={{ type: 'spring', stiffness: 100, damping: 20 }}
    >
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Logo */}
          <motion.div
            className="w-10 h-10 rounded-xl glass-button flex items-center justify-center"
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00ff41" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </motion.div>

          <div>
            <h1 className="text-[#00ff41] font-bold text-lg tracking-wide text-glow">WARP-LAN</h1>
            <p className="text-[#00ff41]/50 text-xs tracking-wider">P2P Secure Transfer</p>
          </div>
        </div>

        {/* Status indicator */}
        <motion.div
          className="flex items-center gap-2 px-4 py-2 glass-panel rounded-full"
          whileHover={{ scale: 1.02 }}
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
            transition={{ duration: 1.5, repeat: Infinity }}
          />
          <span className="text-[#00ff41]/70 text-xs uppercase tracking-wider font-medium">
            E2E Encrypted
          </span>
        </motion.div>
      </div>
    </motion.header>
  );
}
