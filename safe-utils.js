const DEFAULT_FETCH_TIMEOUT = 15000;

function isRepliableInteraction(interaction) {
    return interaction && typeof interaction.isRepliable === 'function' && interaction.isRepliable();
}

async function safeFetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = typeof options.timeout === 'number' ? options.timeout : DEFAULT_FETCH_TIMEOUT;
    const fetchOptions = { ...options, signal: controller.signal };

    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, fetchOptions);
        return response;
    } catch (err) {
        if (err.name === 'AbortError') {
            err.message = `Fetch timeout after ${timeout}ms`;
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function safeFetchJson(url, options = {}) {
    const response = await safeFetch(url, options);
    if (!response.ok) {
        const err = new Error(`HTTP ${response.status} ${response.statusText}`);
        err.response = response;
        throw err;
    }
    return response.json();
}

function createDiscordRestAdapter(proxyAgent) {
    return async (url, options) => {
        const fetchOptions = { ...options };
        if (proxyAgent) {
            fetchOptions.dispatcher = proxyAgent;
        }

        try {
            return await safeFetch(url, fetchOptions);
        } catch (err) {
            console.error('>>> [REST FETCH ERROR] Proxy fetch failed:', err.message);
            if (proxyAgent) {
                console.warn('>>> [REST] Falling back to direct fetch without proxy...');
                const directOptions = { ...options };
                try {
                    return await safeFetch(url, directOptions);
                } catch (innerErr) {
                    console.error('>>> [REST FETCH ERROR] Direct fetch also failed:', innerErr.message);
                    throw innerErr;
                }
            }
            throw err;
        }
    };
}

async function safeReply(interaction, response) {
    if (!isRepliableInteraction(interaction)) return null;
    try {
        if (interaction.replied || interaction.deferred || (typeof interaction.isAcknowledged === 'function' && interaction.isAcknowledged())) {
            return await interaction.followUp(response).catch(err => {
                console.error('>>> [ERROR] Safe followUp failed:', err.message);
                return null;
            });
        }
        return await interaction.reply(response).catch(err => {
            console.error('>>> [ERROR] Safe reply failed:', err.message);
            return null;
        });
    } catch (err) {
        console.error('>>> [ERROR] Safe reply catch:', err.message);
        return null;
    }
}

async function safeEditReply(interaction, response) {
    if (!isRepliableInteraction(interaction)) return null;
    try {
        if (interaction.replied || interaction.deferred || (typeof interaction.isAcknowledged === 'function' && interaction.isAcknowledged())) {
            return await interaction.editReply(response).catch(async (err) => {
                console.error('>>> [ERROR] Safe editReply failed:', err.message);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply(response).catch(err2 => {
                        console.error('>>> [ERROR] Fallback reply after editReply failed:', err2.message);
                        return null;
                    });
                }
                return null;
            });
        }
        return await interaction.reply(response).catch(err => {
            console.error('>>> [ERROR] Safe reply during editReply fallback failed:', err.message);
            return null;
        });
    } catch (err) {
        console.error('>>> [ERROR] Safe edit reply catch:', err.message);
        return null;
    }
}

async function safeDeferReply(interaction, options = {}) {
    if (!interaction || typeof interaction.deferReply !== 'function') return false;
    if (interaction.replied || interaction.deferred || (typeof interaction.isAcknowledged === 'function' && interaction.isAcknowledged())) return true;
    try {
        await interaction.deferReply(options);
        return true;
    } catch (err) {
        // Suppress non-fatal HF Spaces network errors
        if (err.message?.includes('Connect Timeout') || err.message?.includes('ECONNREFUSED') || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
            return false; // Silently ignore — HF network blip, not a real bug
        }
        console.error('>>> [ERROR] Safe defer failed:', err.message);
        return false;
    }
}

async function safeFollowUp(interaction, response) {
    if (!interaction || typeof interaction.followUp !== 'function') return null;
    try {
        return await interaction.followUp(response).catch(err => {
            console.error('>>> [ERROR] Safe followUp failed:', err.message);
            return null;
        });
    } catch (err) {
        console.error('>>> [ERROR] Safe followUp catch:', err.message);
        return null;
    }
}

async function safeMessageReply(message, response) {
    if (!message || typeof message.reply !== 'function') return null;
    try {
        return await message.reply(response).catch(err => {
            console.error('>>> [ERROR] Message reply failed:', err.message);
            return null;
        });
    } catch (err) {
        console.error('>>> [ERROR] Message reply catch:', err.message);
        return null;
    }
}

async function safeChannelSend(channel, response) {
    if (!channel || typeof channel.send !== 'function') return null;
    try {
        return await channel.send(response).catch(err => {
            console.error('>>> [ERROR] Channel send failed:', err.message);
            return null;
        });
    } catch (err) {
        console.error('>>> [ERROR] Channel send catch:', err.message);
        return null;
    }
}

async function safeUserSend(user, response) {
    if (!user || typeof user.send !== 'function') return null;
    try {
        return await user.send(response).catch(err => {
            console.error('>>> [ERROR] User DM failed:', err.message);
            return null;
        });
    } catch (err) {
        console.error('>>> [ERROR] User DM catch:', err.message);
        return null;
    }
}

async function safeMessageEdit(message, response) {
    if (!message || typeof message.edit !== 'function') return null;
    try {
        return await message.edit(response).catch(err => {
            console.error('>>> [ERROR] Message edit failed:', err.message);
            return null;
        });
    } catch (err) {
        console.error('>>> [ERROR] Message edit catch:', err.message);
        return null;
    }
}

// Retry wrapper with exponential backoff for transient network errors
async function safeDeferWithRetry(interaction, options = {}, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (!interaction || typeof interaction.deferReply !== 'function') return false;
            if (interaction.replied || interaction.deferred || (typeof interaction.isAcknowledged === 'function' && interaction.isAcknowledged())) return true;
            
            await interaction.deferReply(options);
            return true;
        } catch (err) {
            const isTransient = err.name === 'AbortError' || 
                                err.code === 'UND_ERR_CONNECT_TIMEOUT' || 
                                err.message?.includes('Connect Timeout') ||
                                err.message?.includes('timeout');
            
            if (!isTransient || attempt === maxRetries - 1) {
                console.error(`>>> [ERROR] Defer failed after ${attempt + 1} attempt(s):`, err.message);
                return false;
            }
            
            const backoffMs = 1000 * Math.pow(2, attempt); // exponential: 1s, 2s, 4s
            console.warn(`>>> [RETRY] Defer attempt ${attempt + 1} failed, retrying in ${backoffMs}ms...`);
            await new Promise(r => setTimeout(r, backoffMs));
        }
    }
    return false;
}

// Similar retry wrapper for fetch operations
async function safeFetchWithRetry(url, options = {}, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await safeFetch(url, options);
        } catch (err) {
            const isTransient = err.name === 'AbortError' || 
                                err.code === 'UND_ERR_CONNECT_TIMEOUT' || 
                                err.message?.includes('Connect Timeout') ||
                                err.message?.includes('timeout');
            
            if (!isTransient || attempt === maxRetries - 1) {
                throw err;
            }
            
            const backoffMs = 1000 * Math.pow(2, attempt); // exponential: 1s, 2s, 4s
            console.warn(`>>> [RETRY] Fetch attempt ${attempt + 1} failed for ${url}, retrying in ${backoffMs}ms...`);
            await new Promise(r => setTimeout(r, backoffMs));
        }
    }
}

const safeInteractionReply = safeReply;
const safeInteractionEditReply = safeEditReply;
const safeInteractionDeferReply = safeDeferReply;
const safeInteractionFollowUp = safeFollowUp;

module.exports = {
    safeFetch,
    safeFetchJson,
    safeFetchWithRetry,
    createDiscordRestAdapter,
    safeReply,
    safeInteractionReply,
    safeInteractionEditReply,
    safeInteractionDeferReply,
    safeInteractionFollowUp,
    safeEditReply,
    safeDeferReply,
    safeDeferWithRetry,
    safeFollowUp,
    safeMessageReply,
    safeChannelSend,
    safeUserSend,
    safeMessageEdit
};
