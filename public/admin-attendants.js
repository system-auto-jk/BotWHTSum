// ===== ATTENDANTS FUNCTIONS =====
const API_BASE = window.API_BASE || '/api';
let currentEditingAttendantId = null;

function normalizeAttendantStatus(status) {
    return ['online', 'busy', 'offline'].includes(status) ? status : 'offline';
}

function getAttendantStatusLabel(status) {
    const normalized = normalizeAttendantStatus(status);
    const labels = {
        online: 'Disponivel',
        busy: 'Em atendimento',
        offline: 'Offline'
    };
    return labels[normalized];
}

async function loadAttendants() {
    try {
        const response = await fetch(`${API_BASE}/attendance/attendants?_ts=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('API indisponivel');

        const data = await response.json();
        currentAttendants = Array.isArray(data) ? data : [];

        const attendantsList = document.getElementById('attendantsList');
        if (!attendantsList) return;

        if (currentAttendants.length === 0) {
            attendantsList.innerHTML = '<div class="no-items">Nenhum atendente registrado ainda</div>';
            return;
        }

        attendantsList.innerHTML = currentAttendants.map(att => {
            const capacity = Number(att.maxConcurrentChats) > 0 ? Number(att.maxConcurrentChats) : 1;
            const active = Array.isArray(att.activeChats) ? att.activeChats.length : 0;
            const status = normalizeAttendantStatus(att.status);
            return `
            <div class="attendance-card">
                <div class="attendance-card-title">
                    <span class="dot ${status === 'online' ? 'online' : status === 'busy' ? 'busy' : 'offline'}"></span>${att.name}
                </div>
                <div class="attendance-card-meta">
                    ${att.email}<br>
                    Login: ${att.login} | Status: ${getAttendantStatusLabel(status)}<br>
                    Capacidade: ${capacity} | Em atendimento: ${active}
                </div>
                <div class="attendance-card-actions">
                    <button class="btn btn-sm btn-info" onclick="openEditAttendantModal('${att.id}')">
                        <i class="fas fa-pen"></i> Editar
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteAttendant('${att.id}')">
                        <i class="fas fa-trash"></i> Remover
                    </button>
                </div>
            </div>
            `;
        }).join('');

        if (typeof renderAttendanceKpis === 'function') {
            renderAttendanceKpis();
        }
    } catch (error) {
        console.error('Erro ao carregar atendentes:', error);
        const attendantsList = document.getElementById('attendantsList');
        if (attendantsList) {
            attendantsList.innerHTML = '<div class="empty-state" style="padding: 24px;"><i class="fas fa-exclamation-circle"></i><h3>Erro ao carregar atendentes</h3></div>';
        }
    }
}

function openAddAttendantModal() {
    currentEditingAttendantId = null;
    resetAttendantForm();
    document.getElementById('attendantModalTitle').textContent = 'Novo Atendente';
    document.getElementById('attendantForm').onsubmit = saveAttendant;
    document.getElementById('attendantModal').classList.add('show');
}

function openEditAttendantModal(attendantId) {
    const att = currentAttendants.find(a => a.id === attendantId);
    if (!att) {
        showAlert('Atendente nao encontrado', 'error');
        return;
    }

    currentEditingAttendantId = attendantId;

    document.getElementById('attendantName').value = att.name || '';
    document.getElementById('attendantEmail').value = att.email || '';
    document.getElementById('attendantLogin').value = att.login || '';
    document.getElementById('attendantPassword').value = '';
    document.getElementById('attendantStatus').value = normalizeAttendantStatus(att.status);
    document.getElementById('attendantMaxConcurrentChats').value = Number(att.maxConcurrentChats) > 0 ? Number(att.maxConcurrentChats) : 1;

    document.getElementById('attendantModalTitle').textContent = 'Editar Atendente';
    document.getElementById('attendantForm').onsubmit = saveAttendant;
    document.getElementById('attendantModal').classList.add('show');
}

function closeAttendantModal() {
    document.getElementById('attendantModal').classList.remove('show');
    currentEditingAttendantId = null;
    resetAttendantForm();
}

document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('attendantModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target.id === 'attendantModal') {
                closeAttendantModal();
            }
        });
    }

    loadAttendanceConcurrencySettings();
    loadAttendanceMessageSettings();
    loadGlobalMessageTemplates();

    // Keep administrative status panel in sync while attendance tab is active.
    setInterval(async () => {
        const isAttendanceVisible = document.getElementById('attendance')?.classList.contains('active');
        if (!isAttendanceVisible) return;
        await loadAttendants();
        if (typeof loadAttendanceSessions === 'function') await loadAttendanceSessions();
        if (typeof loadAttendanceQueue === 'function') await loadAttendanceQueue();
    }, 5000);
});

async function loadGlobalMessageTemplates() {
    try {
        const container = document.getElementById('globalMessageTemplatesList');
        if (!container) return;

        const response = await fetch(`${API_BASE}/messages/templates`);
        if (!response.ok) return;
        const data = await response.json();
        const catalog = Array.isArray(data.catalog) ? data.catalog : [];
        const templates = data && data.templates ? data.templates : {};

        if (!catalog.length) {
            container.innerHTML = '<div class="no-items">Nenhum template encontrado.</div>';
            return;
        }

        container.innerHTML = catalog.map((item) => {
            const value = String(templates[item.key] || '');
            const placeholders = Array.isArray(item.placeholders) && item.placeholders.length
                ? `<div style="font-size:11px;color:#64748b;margin-top:6px;">Variáveis: ${item.placeholders.join(', ')}</div>`
                : '';
            return `
                <div style="border:1px solid #e5e7eb; border-radius:10px; padding:10px;">
                    <div style="font-size:13px; font-weight:700; color:#0f172a; margin-bottom:4px;">${item.label || item.key}</div>
                    <div style="font-size:12px; color:#64748b; margin-bottom:8px;">${item.description || ''}</div>
                    <textarea id="tpl_${item.key}" data-template-key="${item.key}" rows="3" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px; font-size:12px;">${value}</textarea>
                    ${placeholders}
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Erro ao carregar templates globais:', error);
    }
}

async function saveGlobalMessageTemplates() {
    try {
        const container = document.getElementById('globalMessageTemplatesList');
        if (!container) return;

        const fields = Array.from(container.querySelectorAll('textarea[data-template-key]'));
        if (!fields.length) {
            showAlert('Nenhum template para salvar', 'warning');
            return;
        }

        const templates = {};
        for (const field of fields) {
            const key = field.getAttribute('data-template-key');
            const value = (field.value || '').trim();
            if (!key || !value) continue;
            templates[key] = value;
        }

        const response = await fetch(`${API_BASE}/messages/templates`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ templates })
        });

        const result = await response.json();
        if (result.success) {
            showAlert('Templates de mensagens atualizados com sucesso!', 'success');
            await loadGlobalMessageTemplates();
        } else {
            showAlert(result.error || 'Erro ao salvar templates', 'error');
        }
    } catch (error) {
        console.error('Erro ao salvar templates globais:', error);
        showAlert('Erro ao salvar templates de mensagens', 'error');
    }
}

async function saveAttendant(e) {
    if (e && e.preventDefault) e.preventDefault();

    const name = document.getElementById('attendantName').value.trim();
    const email = document.getElementById('attendantEmail').value.trim();
    const login = document.getElementById('attendantLogin').value.trim();
    const password = document.getElementById('attendantPassword').value;
    const status = document.getElementById('attendantStatus').value;
    const maxConcurrentChats = Number(document.getElementById('attendantMaxConcurrentChats').value || 1);

    if (!name || !email || !login) {
        showAlert('Preencha todos os campos obrigatorios', 'error');
        return;
    }

    if (!password && !currentEditingAttendantId) {
        showAlert('Senha e obrigatoria para novo atendente', 'error');
        return;
    }

    if (password && password.length < 6) {
        showAlert('Senha deve ter pelo menos 6 caracteres', 'error');
        return;
    }

    if (!Number.isFinite(maxConcurrentChats) || maxConcurrentChats < 1) {
        showAlert('Capacidade simultanea deve ser maior que zero', 'error');
        return;
    }

    const attendant = {
        name,
        email,
        login,
        status,
        maxConcurrentChats
    };

    if (password) {
        attendant.password = password;
    }

    try {
        let url = `${API_BASE}/attendance/attendants`;
        let method = 'POST';

        if (currentEditingAttendantId) {
            url += `/${currentEditingAttendantId}`;
            method = 'PUT';
        }

        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(attendant)
        });

        const result = await response.json();
        if (result.success || result.id) {
            showAlert(currentEditingAttendantId ? 'Atendente atualizado com sucesso!' : 'Atendente criado com sucesso!', 'success');
            closeAttendantModal();
            await loadAttendants();
            await displayAttendantsStatus();
        } else {
            showAlert(result.error || 'Erro ao salvar atendente', 'error');
        }
    } catch (error) {
        console.error('Erro ao salvar atendente:', error);
        showAlert('Erro ao salvar atendente', 'error');
    }
}

function resetAttendantForm() {
    document.getElementById('attendantForm').reset();
    document.getElementById('attendantStatus').value = 'online';
    const capacityInput = document.getElementById('attendantMaxConcurrentChats');
    if (capacityInput) capacityInput.value = 1;
}

function togglePasswordVisibility() {
    const input = document.getElementById('attendantPassword');
    input.type = input.type === 'password' ? 'text' : 'password';
}

async function deleteAttendant(attendantId) {
    if (!confirm('Tem certeza que deseja remover este atendente?')) return;

    try {
        const response = await fetch(`${API_BASE}/attendance/attendants/${attendantId}`, {
            method: 'DELETE'
        });

        const result = await response.json();
        if (result.success) {
            showAlert('Atendente removido com sucesso', 'success');
            await loadAttendants();
            await displayAttendantsStatus();
        } else {
            showAlert(result.error || 'Erro ao remover atendente', 'error');
        }
    } catch (error) {
        console.error('Erro ao remover atendente:', error);
        showAlert('Erro ao remover atendente', 'error');
    }
}

async function displayAttendantsStatus() {
    try {
        const attendantsStatusList = document.getElementById('attendantsStatusList');

        if (!currentAttendants || currentAttendants.length === 0) {
            if (attendantsStatusList) {
                attendantsStatusList.innerHTML = '<div class="no-items">Nenhum atendente cadastrado</div>';
            }
            return;
        }

        let html = '';
        currentAttendants.forEach(att => {
            const status = normalizeAttendantStatus(att.status);
            const statusColor = status === 'online' ? '#4caf50' : status === 'busy' ? '#ff9800' : '#f44336';
            const capacity = Number(att.maxConcurrentChats) > 0 ? Number(att.maxConcurrentChats) : 1;
            const active = Array.isArray(att.activeChats) ? att.activeChats.length : 0;

            html += `
                <div style="background: #f9f9f9; padding: 12px; border-radius: 8px; border-left: 4px solid ${statusColor}; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight: 600; color: #333; margin-bottom: 4px;">${att.name}</div>
                        <div style="font-size: 12px; color: #999;">${att.email}</div>
                        <div style="font-size: 11px; color: #666;">Capacidade: ${capacity} | Em atendimento: ${active}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-weight: 600; color: ${statusColor}; margin-bottom: 4px;">
                            ${getAttendantStatusLabel(status)}
                        </div>
                        <div style="font-size: 11px; color: #999;">Login: ${att.login}</div>
                    </div>
                </div>
            `;
        });

        if (attendantsStatusList) {
            attendantsStatusList.innerHTML = html;
        }
    } catch (error) {
        console.error('Erro ao exibir status dos atendentes:', error);
    }
}

async function loadAttendanceConcurrencySettings() {
    try {
        const response = await fetch(`${API_BASE}/attendance/settings/concurrency`);
        if (!response.ok) return;

        const data = await response.json();
        const input = document.getElementById('defaultMaxConcurrentChats');
        if (input && Number(data.maxConcurrentChats) > 0) {
            input.value = String(data.maxConcurrentChats);
        }
    } catch (error) {
        console.error('Erro ao carregar configuracao de capacidade:', error);
    }
}

async function saveAttendanceConcurrencySettings() {
    try {
        const maxConcurrentChats = Number(document.getElementById('defaultMaxConcurrentChats').value || 1);
        const applyToAll = true;

        if (!Number.isFinite(maxConcurrentChats) || maxConcurrentChats < 1) {
            showAlert('Informe uma capacidade valida (minimo 1)', 'error');
            return;
        }

        const response = await fetch(`${API_BASE}/attendance/settings/concurrency`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxConcurrentChats, applyToAll })
        });

        const result = await response.json();
        if (result.success) {
            showAlert('Capacidade de atendimento atualizada com sucesso!', 'success');
            const applyCheckbox = document.getElementById('applyDefaultCapacityToAllAttendants');
            if (applyCheckbox) applyCheckbox.checked = false;
            await loadAttendants();
        } else {
            showAlert(result.error || 'Erro ao salvar capacidade', 'error');
        }
    } catch (error) {
        console.error('Erro ao salvar configuracao de capacidade:', error);
        showAlert('Erro ao salvar capacidade de atendimento', 'error');
    }
}

async function loadAttendanceMessageSettings() {
    try {
        const response = await fetch(`${API_BASE}/attendance/settings/messages`);
        if (!response.ok) return;

        const data = await response.json();
        const messages = data && data.messages ? data.messages : {};

        const queueEntry = document.getElementById('attendanceMsgQueueEntry');
        const queueNext = document.getElementById('attendanceMsgQueueNext');
        const queueUpdate = document.getElementById('attendanceMsgQueueUpdate');
        const queueStatus = document.getElementById('attendanceMsgQueueStatus');
        const settingsQueueEntry = document.getElementById('settingsAttendanceMsgQueueEntry');
        const settingsQueueNext = document.getElementById('settingsAttendanceMsgQueueNext');
        const settingsQueueUpdate = document.getElementById('settingsAttendanceMsgQueueUpdate');
        const settingsQueueStatus = document.getElementById('settingsAttendanceMsgQueueStatus');

        if (queueEntry) queueEntry.value = messages.queueEntry || '';
        if (queueNext) queueNext.value = messages.queueNext || '';
        if (queueUpdate) queueUpdate.value = messages.queueUpdate || '';
        if (queueStatus) queueStatus.value = messages.queueStatus || '';
        if (settingsQueueEntry) settingsQueueEntry.value = messages.queueEntry || '';
        if (settingsQueueNext) settingsQueueNext.value = messages.queueNext || '';
        if (settingsQueueUpdate) settingsQueueUpdate.value = messages.queueUpdate || '';
        if (settingsQueueStatus) settingsQueueStatus.value = messages.queueStatus || '';
    } catch (error) {
        console.error('Erro ao carregar textos de atendimento:', error);
    }
}

async function saveAttendanceMessageSettings() {
    try {
        const queueEntry = (
            document.getElementById('attendanceMsgQueueEntry')?.value
            || document.getElementById('settingsAttendanceMsgQueueEntry')?.value
            || ''
        ).trim();
        const queueNext = (
            document.getElementById('attendanceMsgQueueNext')?.value
            || document.getElementById('settingsAttendanceMsgQueueNext')?.value
            || ''
        ).trim();
        const queueUpdate = (
            document.getElementById('attendanceMsgQueueUpdate')?.value
            || document.getElementById('settingsAttendanceMsgQueueUpdate')?.value
            || ''
        ).trim();
        const queueStatus = (
            document.getElementById('attendanceMsgQueueStatus')?.value
            || document.getElementById('settingsAttendanceMsgQueueStatus')?.value
            || ''
        ).trim();

        if (!queueEntry || !queueNext || !queueUpdate || !queueStatus) {
            showAlert('Preencha todos os textos da fila antes de salvar', 'error');
            return;
        }

        const response = await fetch(`${API_BASE}/attendance/settings/messages`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: {
                    queueEntry,
                    queueNext,
                    queueUpdate,
                    queueStatus
                }
            })
        });

        const result = await response.json();
        if (result.success) {
            showAlert('Textos de atendimento atualizados com sucesso!', 'success');
            await loadAttendanceMessageSettings();
        } else {
            showAlert(result.error || 'Erro ao salvar textos de atendimento', 'error');
        }
    } catch (error) {
        console.error('Erro ao salvar textos de atendimento:', error);
        showAlert('Erro ao salvar textos de atendimento', 'error');
    }
}
