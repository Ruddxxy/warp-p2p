import { motion } from "framer-motion";

export function Header() {
  return (
    <motion.header
      className="fixed top-0 left-0 right-0 z-50 bg-bg/80 backdrop-blur-xl border-b border-border/50"
      initial={{ y: -60 }}
      animate={{ y: 0 }}
      transition={{ type: "spring", stiffness: 120, damping: 20 }}
    >
      <nav
        className="max-w-5xl mx-auto px-5 h-14 flex items-center justify-between"
        aria-label="Main navigation"
      >
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center"
            aria-hidden="true"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#6366F1"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <h1 className="text-text font-semibold text-base tracking-tight m-0">warp</h1>
        </div>

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-surface/60 border border-border/50">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-success"
            aria-hidden="true"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span className="text-text-faint text-xs font-medium">E2E Encrypted</span>
        </div>
      </nav>
    </motion.header>
  );
}
