import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { timestampToMoment } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
export { MODULE_NAME };

const MODULE_NAME = 'expireChats';
const TEMPLATE_PATH = 'third-party/expire-chats';
const DEFAULT_EXPIRATION_DAYS = 90;

const defaultSettings = Object.freeze({
    expirationDays: DEFAULT_EXPIRATION_DAYS,
    expireBackups: false,
    autoExpire: false,
});

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }

    return extensionSettings[MODULE_NAME];
}

async function getAllChats() {
    const context = SillyTavern.getContext();
    const characters = context.characters || [];
    const groups = context.groups || [];
    const allChats = [];

    // Fetch chats for all characters
    for (const character of characters) {
        if (!character?.avatar) continue;

        try {
            const response = await fetch('/api/chats/search', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    query: '',
                    avatar_url: character.avatar,
                    group_id: null,
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            const chatsData = await response.json();

            for (const chat of chatsData) {
                allChats.push({
                    character: character,
                    chatData: chat,
                    isGroup: false,
                });
            }
        } catch (error) {
            console.error(`[Expire chats] Failed to fetch chats for character ${character.name}:`, error);
        }
    }

    // Fetch chats for all groups
    for (const group of groups) {
        if (!group?.id) continue;

        try {
            const response = await fetch('/api/chats/search', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    query: '',
                    avatar_url: null,
                    group_id: group.id,
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            const chatsData = await response.json();

            for (const chat of chatsData) {
                allChats.push({
                    group: group,
                    chatData: chat,
                    isGroup: true,
                });
            }
        } catch (error) {
            console.error(`[Expire chats] Failed to fetch group chats for ${group.name}:`, error);
        }
    }

    return allChats;
}

function filterExpiredChats(allChats, expirationDays, currentCharacterId, currentChat, currentGroupId) {
    const expiredChats = [];
    const now = moment();

    for (const chatInfo of allChats) {
        const { character, group, chatData, isGroup } = chatInfo;

        // Skip currently open chat
        if (isGroup && currentGroupId && group?.id === currentGroupId) {
            const chatName = chatData.file_name.replace('.jsonl', '');
            if (chatName === currentChat) {
                continue;
            }
        } else if (!isGroup && character && currentCharacterId !== null) {
            const charIndex = SillyTavern.getContext().characters.indexOf(character);
            if (charIndex === currentCharacterId) {
                const chatName = chatData.file_name.replace('.jsonl', '');
                if (chatName === currentChat) {
                    continue;
                }
            }
        }

        // Check if chat is expired
        if (chatData.last_mes) {
            try {
                const lastMessageDate = timestampToMoment(chatData.last_mes);
                if (!lastMessageDate.isValid()) continue;

                const daysSinceLastMessage = now.diff(lastMessageDate, 'days');
                if (daysSinceLastMessage > expirationDays) {
                    expiredChats.push(chatInfo);
                }
            } catch (error) {
                console.error('[Expire chats] Failed to parse timestamp:', error);
            }
        }
    }

    return expiredChats;
}

async function deleteChat(chatInfo) {
    const { character, group, chatData, isGroup } = chatInfo;

    try {
        if (isGroup) {
            const response = await fetch('/api/chats/group/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    id: chatData.file_name,
                }),
            });
            return response.ok;
        } else {
            const response = await fetch('/api/chats/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    chatfile: chatData.file_name,
                    avatar_url: character.avatar,
                }),
            });
            return response.ok;
        }
    } catch (error) {
        console.error(`[Expire chats] Failed to delete chat ${chatData.file_name}:`, error);
        return false;
    }
}

async function getAllBackups() {
    try {
        const response = await fetch('/api/data-maid/report', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return {
            backups: data.report.chatBackups || [],
            token: data.token,
        };
    } catch (error) {
        console.error('[Expire chats] Failed to fetch backups:', error);
        return { backups: [], token: null };
    }
}

function filterExpiredBackups(backups, expirationDays) {
    const expiredBackups = [];
    const now = moment();

    for (const backup of backups) {
        let backupDate = null;

        // Backup filename format: chat_{name}_{timestamp}.jsonl
        // Example: chat_seraphina_20251005-153136.jsonl
        const match = backup.name.match(/_(\d{8}-\d{6})\.jsonl$/);

        if (match) {
            const timestampStr = match[1];
            try {
                const parsedDate = moment(timestampStr, 'YYYYMMDD--HHmmss');

                if (parsedDate.isValid()) {
                    backupDate = parsedDate;
                } else {
                    console.warn(`[Expire chats] Failed to parse backup timestamp: ${backup.name}, falling back to mtime`);
                }
            } catch (error) {
                console.error('[Expire chats] Failed to parse backup timestamp:', error);
            }
        }

        if (!backupDate && backup.mtime) {
            backupDate = moment(backup.mtime);
        }

        // Check if backup is expired
        if (backupDate && backupDate.isValid()) {
            const daysSinceBackup = now.diff(backupDate, 'days');
            if (daysSinceBackup > expirationDays) {
                expiredBackups.push(backup);
            }
        }
    }

    return expiredBackups;
}

async function deleteBackups(backupHashes, token) {
    if (!backupHashes || backupHashes.length === 0 || !token) {
        return { success: true, count: 0 };
    }

    try {
        const response = await fetch('/api/data-maid/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                hashes: backupHashes,
                token: token,
            }),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        return { success: true, count: backupHashes.length };
    } catch (error) {
        console.error('[Expire chats] Failed to delete backups:', error);
        return { success: false, count: 0 };
    }
}

async function finalizeDataMaid(token) {
    if (!token) return;

    try {
        await fetch('/api/data-maid/finalize', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ token }),
        });
    } catch (error) {
        console.error('[Expire chats] Failed to finalize data maid:', error);
    }
}

async function getExpiredItems() {
    const settings = getSettings();
    const expirationDays = parseInt(settings.expirationDays) || DEFAULT_EXPIRATION_DAYS;
    const expireBackups = settings.expireBackups;

    const context = SillyTavern.getContext();
    const currentCharacterId = context.characterId;
    const currentChat = context.characters[currentCharacterId]?.chat;
    const currentGroupId = context.groupId;

    const allChats = await getAllChats();

    const expiredChats = filterExpiredChats(
        allChats,
        expirationDays,
        currentCharacterId,
        currentChat,
        currentGroupId
    );

    // Get expired backups if enabled
    let expiredBackups = [];
    let backupToken = null;
    if (expireBackups) {
        const backupData = await getAllBackups();
        backupToken = backupData.token;
        expiredBackups = filterExpiredBackups(backupData.backups, expirationDays);
    }

    return {
        expiredChats,
        expiredBackups,
        backupToken,
        expirationDays,
    };
}

async function autoExpireChats() {
    try {
        const { expiredChats, expiredBackups, backupToken } = await getExpiredItems();

        // If nothing to delete, exit silently
        if (expiredChats.length === 0 && expiredBackups.length === 0) {
            if (backupToken) {
                await finalizeDataMaid(backupToken);
            }
            return;
        }

        // Delete chats and backups silently
        let chatSuccessCount = 0;
        let chatFailCount = 0;

        if (expiredChats.length > 0) {
            console.log(`[Expire chats] Auto-deleting ${expiredChats.length} chat${expiredChats.length !== 1 ? 's' : ''}...`);

            for (const chatInfo of expiredChats) {
                const name = chatInfo.isGroup ? chatInfo.group.name : chatInfo.character.name;
                const chatName = chatInfo.chatData.file_name.replace('.jsonl', '');
                const lastMes = chatInfo.chatData.last_mes
                    ? timestampToMoment(chatInfo.chatData.last_mes).format('MMM D, YYYY')
                    : 'Unknown';
                console.log(`[Expire chats] Deleting chat: ${name} - ${chatName} (Last message: ${lastMes})`);

                const success = await deleteChat(chatInfo);
                if (success) {
                    chatSuccessCount++;
                } else {
                    chatFailCount++;
                }
            }
        }

        let backupSuccessCount = 0;
        let backupFailCount = 0;
        if (expiredBackups.length > 0 && backupToken) {
            console.log(`[Expire chats] Auto-deleting ${expiredBackups.length} backup${expiredBackups.length !== 1 ? 's' : ''}...`);

            for (const backup of expiredBackups) {
                console.log(`[Expire chats] Deleting backup: ${backup.name}`);
            }

            const backupHashes = expiredBackups.map(b => b.hash);
            const deleteResult = await deleteBackups(backupHashes, backupToken);

            if (deleteResult.success) {
                backupSuccessCount = deleteResult.count;
            } else {
                backupFailCount = expiredBackups.length;
            }
        }

        if (backupToken) {
            await finalizeDataMaid(backupToken);
        }

        // Show toast notification
        const totalSuccess = chatSuccessCount + backupSuccessCount;
        const totalFailed = chatFailCount + backupFailCount;

        let message = `Expired ${totalSuccess} item${totalSuccess !== 1 ? 's' : ''}`;
        if (chatSuccessCount > 0 && backupSuccessCount > 0) {
            message = `Expired ${chatSuccessCount} chat${chatSuccessCount !== 1 ? 's' : ''} and ${backupSuccessCount} backup${backupSuccessCount !== 1 ? 's' : ''}`;
        } else if (chatSuccessCount > 0) {
            message = `Expired ${chatSuccessCount} chat${chatSuccessCount !== 1 ? 's' : ''}`;
        } else if (backupSuccessCount > 0) {
            message = `Expired ${backupSuccessCount} backup${backupSuccessCount !== 1 ? 's' : ''}`;
        }

        if (totalFailed > 0) {
            message += ` (${totalFailed} failed)`;
        }

        toastr.success(message, 'Expire chats');
        console.log(`[Expire chats] ${message}`);

    } catch (error) {
        console.error('[Expire chats] Failed to auto-expire chats:', error);
        toastr.error('Failed to auto-expire chats. Check console for details.', 'Expire chats');
    }
}

async function previewExpiredChats() {
    try {
        const { expiredChats, expiredBackups, backupToken, expirationDays } = await getExpiredItems();

        const settings = getSettings();
        const expireBackups = settings.expireBackups;

        if (expiredChats.length === 0 && expiredBackups.length === 0) {
            let message = `No chats found older than ${expirationDays} days.`;
            if (expireBackups) {
                message = `No chats or backups found older than ${expirationDays} days.`;
            }
            await callGenericPopup(message, POPUP_TYPE.TEXT);
            if (backupToken) {
                await finalizeDataMaid(backupToken);
            }
            return;
        }

        // Build preview message
        const characterChatCount = expiredChats.filter(c => !c.isGroup).length;
        const groupChatCount = expiredChats.filter(c => c.isGroup).length;

        let previewMessage = `<div class="expire_chats expire_chats_preview">`;

        if (expiredChats.length > 0) {
            previewMessage += `<p><strong>Found ${expiredChats.length} chat${expiredChats.length !== 1 ? 's' : ''} older than ${expirationDays} days:</strong></p>`;
            previewMessage += `<ul>`;
            previewMessage += `<li>${characterChatCount} character chat${characterChatCount !== 1 ? 's' : ''}</li>`;
            previewMessage += `<li>${groupChatCount} group chat${groupChatCount !== 1 ? 's' : ''}</li>`;
            previewMessage += `</ul>`;

            // Group chats by name and show counts
            const chatsByName = {};
            for (const chat of expiredChats) {
                const name = chat.isGroup ? chat.group.name : chat.character.name;
                if (!chatsByName[name]) {
                    chatsByName[name] = 0;
                }
                chatsByName[name]++;
            }

            // Sort by count descending, then alphabetically
            const sortedNames = Object.entries(chatsByName)
                .sort((a, b) => {
                    if (b[1] !== a[1]) return b[1] - a[1];
                    return a[0].localeCompare(b[0]);
                });

            previewMessage += `<p><strong>Chats:</strong></p>`;
            previewMessage += `<ul>`;

            for (const [name, count] of sortedNames) {
                previewMessage += `<li><strong>${name}</strong>: ${count} chat${count !== 1 ? 's' : ''}</li>`;
            }

            previewMessage += `</ul>`;
        }

        // Show backup information if enabled
        if (expireBackups && expiredBackups.length > 0) {
            // Group backups by chat name
            const backupsByChat = {};
            for (const backup of expiredBackups) {
                // Extract chat name from filename: chat_{name}_{timestamp}.jsonl
                const match = backup.name.match(/^chat_(.+?)_\d{8}-\d{6}\.jsonl$/);
                if (match) {
                    const chatName = match[1];
                    if (!backupsByChat[chatName]) {
                        backupsByChat[chatName] = 0;
                    }
                    backupsByChat[chatName]++;
                }
            }

            previewMessage += `<p><strong>Found ${expiredBackups.length} backup${expiredBackups.length !== 1 ? 's' : ''} older than ${expirationDays} days:</strong></p>`;
            previewMessage += `<ul>`;

            const sortedChats = Object.entries(backupsByChat)
                .sort((a, b) => {
                    if (b[1] !== a[1]) return b[1] - a[1];
                    return a[0].localeCompare(b[0]);
                });

            for (const [chatName, count] of sortedChats) {
                previewMessage += `<li><strong>${chatName}</strong>: ${count} backup${count !== 1 ? 's' : ''}</li>`;
            }

            previewMessage += `</ul>`;
        }

        previewMessage += `<p style="color: #ff6b6b; margin-top: 10px;"><strong>⚠️ This action cannot be undone!</strong></p>`;
        previewMessage += `</div>`;

        const result = await callGenericPopup(
            previewMessage,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Delete', cancelButton: 'Cancel' }
        );

        if (result) {
            await expireChats(expiredChats, expiredBackups, backupToken);
        } else {
            // User cancelled, finalize the token
            if (backupToken) {
                await finalizeDataMaid(backupToken);
            }
        }
    } catch (error) {
        console.error('[Expire chats] Failed to preview expired chats:', error);
        await callGenericPopup(
            'An error occurred while scanning chats. Please check the console for details.',
            POPUP_TYPE.TEXT
        );
    }
}

async function expireChats(expiredChats, expiredBackups = [], backupToken = null) {
    let chatSuccessCount = 0;
    let chatFailCount = 0;
    const failedChats = [];

    // Delete chats
    if (expiredChats.length > 0) {
        const progressMessage = `[Expire chats] Deleting ${expiredChats.length} chat${expiredChats.length !== 1 ? 's' : ''}...`;
        console.log(progressMessage);

        for (const chatInfo of expiredChats) {
            const name = chatInfo.isGroup ? chatInfo.group.name : chatInfo.character.name;
            const chatName = chatInfo.chatData.file_name.replace('.jsonl', '');
            const lastMes = chatInfo.chatData.last_mes
                ? timestampToMoment(chatInfo.chatData.last_mes).format('MMM D, YYYY')
                : 'Unknown';
            console.log(`[Expire chats] Deleting chat: ${name} - ${chatName} (Last message: ${lastMes})`);

            const success = await deleteChat(chatInfo);
            if (success) {
                chatSuccessCount++;
            } else {
                chatFailCount++;
                failedChats.push(`${name}: ${chatInfo.chatData.file_name}`);
            }
        }
    }

    // Delete backups if enabled
    let backupSuccessCount = 0;
    let backupFailCount = 0;
    if (expiredBackups.length > 0 && backupToken) {
        console.log(`[Expire chats] Deleting ${expiredBackups.length} backup${expiredBackups.length !== 1 ? 's' : ''}...`);

        for (const backup of expiredBackups) {
            console.log(`[Expire chats] Deleting backup: ${backup.name}`);
        }

        const backupHashes = expiredBackups.map(b => b.hash);
        const deleteResult = await deleteBackups(backupHashes, backupToken);

        if (deleteResult.success) {
            backupSuccessCount = deleteResult.count;
        } else {
            backupFailCount = expiredBackups.length;
        }
    }

    if (backupToken) {
        await finalizeDataMaid(backupToken);
    }

    // Show results
    let resultMessage = `<div class="expire_chats expire_chats_result">`;
    resultMessage += `<p><strong>Expiration complete</strong></p>`;

    if (expiredChats.length > 0) {
        resultMessage += `<p><strong>Chats:</strong></p>`;
        resultMessage += `<ul>`;
        resultMessage += `<li>✓ Successfully deleted: ${chatSuccessCount}</li>`;
        if (chatFailCount > 0) {
            resultMessage += `<li>✗ Failed to delete: ${chatFailCount}</li>`;
        }
        resultMessage += `</ul>`;
    }

    if (expiredBackups.length > 0) {
        resultMessage += `<p><strong>Backups:</strong></p>`;
        resultMessage += `<ul>`;
        resultMessage += `<li>✓ Successfully deleted: ${backupSuccessCount}</li>`;
        if (backupFailCount > 0) {
            resultMessage += `<li>✗ Failed to delete: ${backupFailCount}</li>`;
        }
        resultMessage += `</ul>`;
    }

    if (failedChats.length > 0) {
        resultMessage += `<p><strong>Failed chats:</strong></p>`;
        resultMessage += `<ul style="max-height: 150px; overflow-y: auto;">`;
        for (const failed of failedChats) {
            resultMessage += `<li>${failed}</li>`;
        }
        resultMessage += `</ul>`;
    }

    resultMessage += `</div>`;

    await callGenericPopup(resultMessage, POPUP_TYPE.TEXT);

    console.log(`[Expire chats] Expired ${chatSuccessCount} chats and ${backupSuccessCount} backups. ${chatFailCount + backupFailCount} failed.`);
}

function onExpirationDaysInput() {
    const value = parseInt($('#expire_chats_days').val()) || DEFAULT_EXPIRATION_DAYS;
    const settings = getSettings();
    settings.expirationDays = Math.max(1, value); // Minimum 1 day
    saveSettingsDebounced();
}

function onExpireBackupsChange() {
    const settings = getSettings();
    settings.expireBackups = !!$('#expire_chats_backups').prop('checked');
    saveSettingsDebounced();
}

function onAutoExpireChange() {
    const settings = getSettings();
    settings.autoExpire = !!$('#expire_chats_auto').prop('checked');
    saveSettingsDebounced();
}

async function onPreviewClick() {
    const $button = $('#expire_chats_button');
    $button.prop('disabled', true);
    try {
        await previewExpiredChats();
    } finally {
        $button.prop('disabled', false);
    }
}

async function loadSettings() {
    const settings = getSettings();
    $('#expire_chats_days').val(settings.expirationDays);
    $('#expire_chats_backups').prop('checked', settings.expireBackups);
    $('#expire_chats_auto').prop('checked', settings.autoExpire);
}

jQuery(async () => {
    const settingsHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings').append(settingsHtml);

    loadSettings();

    $('#expire_chats_days').on('input', onExpirationDaysInput);
    $('#expire_chats_backups').on('change', onExpireBackupsChange);
    $('#expire_chats_auto').on('change', onAutoExpireChange);
    $('#expire_chats_button').on('click', onPreviewClick);

    // Run auto-expiration on page load if enabled
    const settings = getSettings();
    if (settings.autoExpire) {
        // Delay slightly to avoid blocking page load
        setTimeout(() => {
            autoExpireChats();
        }, 1000);
    }
});
