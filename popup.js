// Track save-feedback timer to avoid stale "Saved!" flickers on rapid saves.
let saveFeedbackTimer = null;

// AbortController for the current in-flight fetch — cancelled when a new fetch starts.
let fetchAbortController = null;

document.addEventListener('DOMContentLoaded', async function () {
    await migratePatFromSync();

    const items = await chrome.storage.local.get(['organization', 'project', 'repository', 'pat']);

    document.getElementById('organization').value = items.organization || '';
    document.getElementById('project').value = items.project || '';
    document.getElementById('repository').value = items.repository || '';
    document.getElementById('pat').value = items.pat || '';

    document.getElementById('save').addEventListener('click', handleSave);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * One-time migration: if the PAT was saved in chrome.storage.sync (old behaviour),
 * move everything to chrome.storage.local and remove the sync copy.
 */
async function migratePatFromSync() {
    try {
        const syncData = await chrome.storage.sync.get(['organization', 'project', 'repository', 'pat']);
        const hasSyncData = Object.values(syncData).some(Boolean);
        if (!hasSyncData) return;

        const localData = await chrome.storage.local.get(['organization', 'project', 'repository', 'pat']);
        const hasLocalData = Object.values(localData).some(Boolean);

        // Only migrate if local storage is empty — don't overwrite a newer local save.
        if (!hasLocalData) {
            await chrome.storage.local.set(syncData);
        }

        await chrome.storage.sync.remove(['organization', 'project', 'repository', 'pat']);
    } catch (_) {
        // Sync storage may be unavailable in some configurations — migration is best-effort.
    }
}

// ---------------------------------------------------------------------------
// Save handler
// ---------------------------------------------------------------------------

async function handleSave() {
    const organization = document.getElementById('organization').value.trim();
    const project = document.getElementById('project').value.trim();
    const repository = document.getElementById('repository').value.trim();
    const pat = document.getElementById('pat').value.trim();

    if (!organization || !project || !repository || !pat) {
        showSaveFeedback('Please fill in all fields.', true);
        return;
    }

    const saveBtn = document.getElementById('save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    await chrome.storage.local.set({ organization, project, repository, pat });

    saveBtn.textContent = 'Save Settings';
    saveBtn.disabled = false;

    showSaveFeedback('Saved!', false);
    fetchPullRequests(organization, project, repository, pat);
}

function showSaveFeedback(message, isError) {
    clearTimeout(saveFeedbackTimer);
    const feedback = document.getElementById('save-feedback');
    feedback.textContent = message;
    feedback.className = 'save-feedback ' + (isError ? 'save-feedback-error' : 'save-feedback-ok');
    saveFeedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 2500);
}

// ---------------------------------------------------------------------------
// DOM helpers (XSS-safe — never use innerHTML with dynamic content)
// ---------------------------------------------------------------------------

/**
 * Create an element with optional props and children.
 * Props are applied as properties (not attributes) where possible.
 * Children may be strings (converted to text nodes) or Elements.
 */
function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, val] of Object.entries(props || {})) {
        if (key === 'className') {
            node.className = val;
        } else if (key === 'textContent') {
            node.textContent = val;
        } else if (key === 'href') {
            // Use the property assignment so it is subject to browser URL validation.
            node.href = val;
        } else {
            node.setAttribute(key, val);
        }
    }
    for (const child of (children || [])) {
        if (child == null) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
}

// ---------------------------------------------------------------------------
// Tab rendering
// ---------------------------------------------------------------------------

/**
 * Build the creator tabs plus an "All" first tab.
 * Tab element IDs are index-based, never derived from creator names,
 * to avoid collisions with special characters.
 */
function createTabs(pullRequests, organization, project, repository) {
    const tabsContainer = document.getElementById('tabs');
    const tabContents = document.getElementById('tab-contents');
    tabsContainer.replaceChildren();
    tabContents.replaceChildren();

    // Group PRs by creator display name.
    const prsByCreator = {};
    for (const pr of pullRequests) {
        const name = pr.createdBy?.displayName || 'Unknown';
        (prsByCreator[name] = prsByCreator[name] || []).push(pr);
    }

    // Sort creators alphabetically for deterministic tab order.
    const sortedCreators = Object.keys(prsByCreator).sort((a, b) => a.localeCompare(b));

    // "All" tab is always first.
    const tabDefs = [
        { id: 'all', label: 'All', prs: pullRequests },
        ...sortedCreators.map((name, i) => ({ id: String(i), label: name, prs: prsByCreator[name] }))
    ];

    tabDefs.forEach(({ id, label, prs }, index) => {
        // Tab button
        const countBadge = el('span', { className: 'pr-count', textContent: String(prs.length) });
        const tab = el('div', { className: index === 0 ? 'tab active' : 'tab' }, [label, countBadge]);
        tab.dataset.target = id;
        tabsContainer.appendChild(tab);

        // Tab content panel
        const content = el('div', {
            className: index === 0 ? 'tab-content active' : 'tab-content',
            id: 'content-tab-' + id,
        });
        renderPRs(prs, content, organization, project, repository);
        tabContents.appendChild(content);
    });

    // Tab switching — scoped to this render's containers to avoid stale listeners.
    tabsContainer.addEventListener('click', function (e) {
        const tab = e.target.closest('.tab');
        if (!tab) return;

        tabsContainer.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tabContents.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        tab.classList.add('active');
        const panel = document.getElementById('content-tab-' + tab.dataset.target);
        if (panel) panel.classList.add('active');
    });
}

function renderPRs(prs, container, organization, project, repository) {
    if (prs.length === 0) {
        container.appendChild(el('p', { className: 'empty-state', textContent: 'No pull requests.' }));
        return;
    }

    // Sort newest first.
    const sorted = [...prs].sort((a, b) => new Date(b.creationDate) - new Date(a.creationDate));

    for (const pr of sorted) {
        const creatorName = pr.createdBy?.displayName || 'Unknown';
        const prId = pr.pullRequestId;
        const prUrl = 'https://dev.azure.com/'
            + encodeURIComponent(organization) + '/'
            + encodeURIComponent(project) + '/_git/'
            + encodeURIComponent(repository) + '/pullrequest/'
            + prId;

        let createdText = 'Unknown date';
        if (pr.creationDate) {
            const d = new Date(pr.creationDate);
            if (!isNaN(d)) createdText = d.toLocaleDateString();
        }

        const statusText = pr.status || 'unknown';
        const statusBadge = el('span', {
            className: 'status status-' + statusText.toLowerCase(),
            textContent: statusText,
        });

        const link = el('a', {
            href: prUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            textContent: 'View PR #' + prId,
        });

        const prItem = el('div', { className: 'pr-item' }, [
            el('h3', { textContent: pr.title || 'Untitled PR' }),
            el('p', {}, ['Created by: ', el('strong', { textContent: creatorName })]),
            el('p', {}, ['Status: ', statusBadge]),
            el('p', { textContent: 'Created: ' + createdText }),
            link,
        ]);

        container.appendChild(prItem);
    }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function fetchPullRequests(organization, project, repository, pat) {
    // Cancel any previous in-flight fetch.
    if (fetchAbortController) {
        fetchAbortController.abort();
    }
    fetchAbortController = new AbortController();
    const signal = fetchAbortController.signal;

    const tabsContainer = document.getElementById('tabs');
    const tabContents = document.getElementById('tab-contents');
    tabsContainer.replaceChildren();
    tabContents.replaceChildren();
    tabsContainer.appendChild(el('div', { className: 'loading', textContent: 'Loading pull requests…' }));

    const headers = new Headers({
        Authorization: 'Basic ' + btoa(':' + pat),
    });

    try {
        const allPRs = [];
        let skip = 0;
        const top = 100;

        // Paginate until we have all active PRs.
        while (true) {
            const url = 'https://dev.azure.com/'
                + encodeURIComponent(organization) + '/'
                + encodeURIComponent(project) + '/_apis/git/repositories/'
                + encodeURIComponent(repository) + '/pullrequests'
                + '?searchCriteria.status=active'
                + '&$top=' + top
                + '&$skip=' + skip
                + '&api-version=7.1';

            const response = await fetch(url, { headers, signal });

            if (!response.ok) {
                throw new Error(httpErrorMessage(response.status));
            }

            let data;
            try {
                data = await response.json();
            } catch (_) {
                throw new Error('Server returned an unexpected response. Check your organization, project, and repository names.');
            }

            if (!data?.value) {
                throw new Error('Unexpected API response format. Check your organization, project, and repository names.');
            }

            allPRs.push(...data.value);

            // Fewer items than requested means this is the last page.
            if (data.value.length < top) break;
            skip += top;
        }

        tabsContainer.replaceChildren();

        if (allPRs.length === 0) {
            tabsContainer.appendChild(el('p', { className: 'empty-state', textContent: 'No active pull requests found.' }));
            return;
        }

        createTabs(allPRs, organization, project, repository);
    } catch (error) {
        // Ignore aborted fetches — a newer fetch has already taken over the UI.
        if (error.name === 'AbortError') return;
        tabsContainer.replaceChildren();
        tabsContainer.appendChild(
            el('div', { className: 'error-message' }, [
                el('strong', { textContent: 'Error: ' }),
                document.createTextNode(error.message),
                el('p', { textContent: 'Please check your settings and try again.' }),
            ])
        );
    }
}

function httpErrorMessage(status) {
    switch (status) {
        case 401: return 'Authentication failed (401). Check that your PAT is valid and not expired.';
        case 403: return 'Access denied (403). Ensure your PAT has the Code (Read) scope.';
        case 404: return 'Not found (404). Check your organization, project, and repository names.';
        case 429: return 'Rate limited (429). Please wait a moment and try again.';
        default:  return 'Request failed with HTTP ' + status + '.';
    }
}
