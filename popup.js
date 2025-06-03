document.addEventListener('DOMContentLoaded', function() {
    chrome.storage.sync.get(['organization', 'project', 'repository', 'pat'], function(items) {
        document.getElementById('organization').value = items.organization || '';
        document.getElementById('project').value = items.project || '';
        document.getElementById('repository').value = items.repository || '';
        document.getElementById('pat').value = items.pat || '';
        
        if (items.organization && items.project && items.repository && items.pat) {
            fetchPullRequests(items.organization, items.project, items.repository, items.pat);
        }
    });
    
    document.getElementById('save').addEventListener('click', function() {
        const organization = document.getElementById('organization').value;
        const project = document.getElementById('project').value;
        const repository = document.getElementById('repository').value;
        const pat = 'abc132133iaaisdjwei23'
        
        chrome.storage.sync.set({
            organization: organization,
            project: project,
            repository: repository,
            pat: pat
        }, function() {
            fetchPullRequests(organization, project, repository, pat);
        });
    });
});

function createTabs(pullRequests) {
    const tabsContainer = document.getElementById('tabs');
    const tabContents = document.getElementById('tab-contents');
    
    tabsContainer.innerHTML = '';
    tabContents.innerHTML = '';
    
    const prsByCreator = {};
    pullRequests.forEach(pr => {
        const creatorName = pr.createdBy ? pr.createdBy.displayName : 'Unknown';
        if (!prsByCreator[creatorName]) {
            prsByCreator[creatorName] = [];
        }
        prsByCreator[creatorName].push(pr);
    });
    
    Object.entries(prsByCreator).forEach(([creator, prs], index) => {
        const tab = document.createElement('div');
        tab.className = 'tab';
        if (index === 0) tab.classList.add('active'); 
        tab.dataset.target = creator;
        tab.innerHTML = `${creator}<span class="pr-count">${prs.length}</span>`;
        tabsContainer.appendChild(tab);
        
        // Create content
        const content = document.createElement('div');
        content.className = 'tab-content';
        if (index === 0) content.classList.add('active'); 
        content.id = `content-${creator.replace(/\s+/g, '-')}`;
        renderPRs(prs, content);
        tabContents.appendChild(content);
    });
    
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            const targetId = `content-${tab.dataset.target.replace(/\s+/g, '-')}`;
            const content = document.getElementById(targetId);
            if (content) {
                content.classList.add('active');
            }
        });
    });
}

function renderPRs(prs, container) {
    prs.forEach(pr => {
        const prElement = document.createElement('div');
        prElement.className = 'pr-item';
        
        const creatorName = pr.createdBy ? pr.createdBy.displayName : 'Unknown';
        
        const organization = document.getElementById('organization').value;
        const project = document.getElementById('project').value;
        const repository = document.getElementById('repository').value;
        const prId = pr.pullRequestId;
        
        const prUrl = `https://dev.azure.com/${organization}/${project}/_git/${repository}/pullrequest/${prId}`;
        
        prElement.innerHTML = `
        <h3>${pr.title || 'Untitled PR'}</h3>
        <p>Created by: ${creatorName}</p>
        <p>Status: ${pr.status || 'Unknown'}</p>
        <p>Created: ${new Date(pr.creationDate).toLocaleDateString()}</p>
        <a href="${prUrl}" target="_blank">View PR #${prId}</a>
      `;
        container.appendChild(prElement);
    });
}

function fetchPullRequests(organization, project, repository, pat) {
    const repoApiUrl = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repository}?api-version=6.0`;
    const headers = new Headers();
    headers.append('Authorization', 'Basic ' + btoa(':' + pat));
    
    const tabsContainer = document.getElementById('tabs');
    const tabContents = document.getElementById('tab-contents');
    tabsContainer.innerHTML = 'Loading...';
    tabContents.innerHTML = '';
    
    fetch(repoApiUrl, {
        method: 'GET',
        headers: headers
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(repoData => {
        if (!repoData || !repoData.id) {
            throw new Error('Repository not found');
        }
        
        const prApiUrl = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repoData.id}/pullrequests?api-version=6.0`;
        return fetch(prApiUrl, {
            method: 'GET',
            headers: headers
        });
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        console.log('API Response:', data);
        
        if (!data || !data.value) {
            throw new Error('Invalid API response format');
        }
        
        tabsContainer.innerHTML = '';
        
        if (data.value.length === 0) {
            tabsContainer.innerHTML = 'No pull requests found.';
            return;
        }
        
        createTabs(data.value);
    })
    .catch(error => {
        console.error('Error:', error);
        tabsContainer.innerHTML = `Error: ${error.message}<br>Please check your organization name, project name, repository name, and PAT are correct.`;
    });
}
