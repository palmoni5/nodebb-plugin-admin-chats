'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Benchpress = require('benchpressjs');

const template = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'partials', 'chats', 'message-window.tpl'),
    'utf8'
);

async function render(data) {
    return await Benchpress.compileRender(template, {
        widgets: { header: [] },
        roomId: 1,
        showUserInput: false,
        adminChatLockedForViewer: false,
        ...data,
    });
}

test('does not show the lock banner merely because the composer is hidden', async () => {
    const html = await render({ adminChatLockedForViewer: false });
    assert.doesNotMatch(html, /admin-chat-lock-banner/);
});

test('shows the lock banner when the room is locked for the viewer', async () => {
    const html = await render({ adminChatLockedForViewer: true });
    assert.match(html, /admin-chat-lock-banner/);
});
