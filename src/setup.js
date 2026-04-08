// Polyfill for process in browser
if (typeof window !== 'undefined' && !window.process) {
  window.process = {
    env: { NODE_ENV: 'production' },
    nextTick: function(callback) {
      setTimeout(callback, 0);
    },
    cwd: function() { return '/'; }
  };
} else if (typeof window !== 'undefined' && window.process && !window.process.nextTick) {
  window.process.nextTick = function(callback) {
    setTimeout(callback, 0);
  };
}