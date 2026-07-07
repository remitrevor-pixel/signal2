// Key Rotation Manager
// Distributes requests across multiple API keys using round-robin
// Automatically falls back if a key fails

class KeyRotator {
  constructor(keys) {
    this.keys = Array.isArray(keys) ? keys.filter(k => k) : [];
    this.currentIndex = 0;
    this.failedKeys = new Set();
    this.lastUsed = {};
  }

  // Get next key (round-robin)
  getNext() {
    if (this.keys.length === 0) return null;

    // Skip failed keys
    let attempts = 0;
    while (this.failedKeys.has(this.keys[this.currentIndex]) && attempts < this.keys.length) {
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      attempts++;
    }

    // If all keys failed, reset and try again
    if (attempts === this.keys.length) {
      this.failedKeys.clear();
    }

    const key = this.keys[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    return key;
  }

  // Mark a key as failed (temporary)
  markFailed(key) {
    this.failedKeys.add(key);
    console.log(`[KeyRotator] Marked key as failed: ${key.substring(0, 8)}...`);
  }

  // Reset a key (after some time)
  resetKey(key) {
    this.failedKeys.delete(key);
    console.log(`[KeyRotator] Reset key: ${key.substring(0, 8)}...`);
  }

  // Get all keys
  getAllKeys() {
    return this.keys;
  }

  // Get stats
  getStats() {
    return {
      total: this.keys.length,
      failed: this.failedKeys.size,
      available: this.keys.length - this.failedKeys.size,
      failedKeys: Array.from(this.failedKeys).map(k => k.substring(0, 8) + '...')
    };
  }
}

module.exports = KeyRotator;
