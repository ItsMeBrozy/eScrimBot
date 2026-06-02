# HuggingFace Spaces Network Configuration

## Issue
HuggingFace Spaces free tier has network restrictions that can cause transient `Connect Timeout` errors when the bot tries to reach Discord's API or perform network operations.

## Errors You May See
```
>>> [ERROR] Interaction failed for /givepoints: Connect Timeout Error
UND_ERR_CONNECT_TIMEOUT (attempted addresses: 162.159.x.x:443, timeout: 10000ms)
```

## Solutions

### 1. **Enable Retry Logic (NOW ACTIVE ✓)**
The bot now includes exponential backoff retry logic:
- `safeDeferWithRetry` - Retries interaction deferral up to 3 times with backoff
- `safeFetchWithRetry` - Retries network requests with 1s → 2s → 4s delays
- Transient errors (timeouts) are retried automatically
- Permanent errors (auth failures) fail immediately

**Result:** Temporary network blips no longer crash the bot.

### 2. **Suppress Non-Fatal Errors (NOW ACTIVE ✓)**
Timeout errors in background tasks (like leaderboard updates) are now logged as warnings instead of errors:
```
>>> [LEADERBOARD] Skipped update (timeout — Discord unreachable, likely HF Spaces network restriction)
```

This prevents log spam and makes the bot appear more stable even during network issues.

### 3. **HF Spaces Settings (OPTIONAL - Manual Configuration)**

If timeouts persist, check your HuggingFace Space's network settings:

1. Go to your Space → **Settings** (⚙️ icon)
2. Look for **"Variables and secrets"** or **"Network policy"** sections
3. Verify Discord's domains are **whitelisted**:
   - `discord.com`
   - `discordapp.com`
   - `cdn.discordapp.com`

If there's a network allowlist:
- Add Discord domains to it
- Or disable the allowlist entirely (less restrictive but more open)

### 4. **Upgrade to HF Pro/Enterprise (RECOMMENDED for Production)**

Free tier limitations:
- Transient network timeouts are **expected and hard to eliminate**
- Network is shared and may have throttling
- No persistent storage or guaranteed uptime

Pro/Enterprise benefits:
- Better network reliability and higher throughput
- Persistent storage
- Dedicated resources
- Priority support

**Current workaround:** With retry logic now in place, the free tier should be usable for moderate traffic. The bot will gracefully handle and retry transient failures.

## Status

✅ **Retry Logic:** Implemented - Handles transient network errors  
✅ **Error Suppression:** Implemented - Reduces log noise  
⚠️ **Network Allowlist:** Check manually if timeouts persist  
📋 **HF Pro:** Consider if you need 24/7 reliability

## Testing

To verify retry logic is working:
1. Check console for `>>> [RETRY]` messages when timeouts occur
2. Verify commands still eventually succeed even after network hiccups
3. Monitor logs for pattern of transient failures that recover

If you see the same command succeed after a retry, the system is working as designed!
