// ============================================================
// FUNÇÕES MODERNAS PARA GERENCIAMENTO DE CADASTROS
// ============================================================

// Estado global para cadastros (compatível com admin.html e admin-modern.html)
window.currentRegistrations = window.currentRegistrations || [];
window.filteredRegistrations = window.filteredRegistrations || [];
window.currentViewingRegistrationId = window.currentViewingRegistrationId || null;

function formatRegistrationHistory(history) {
    const items = Array.isArray(history) ? [...history].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)) : [];
    if (items.length === 0) {
        return `
            <div class="timeline-item">
                <div class="timeline-marker created"></div>
                <div class="timeline-content">
                    <div class="timeline-title">Sem historico detalhado</div>
                    <div class="timeline-date">Este cadastro nao possui eventos registrados ainda.</div>
                </div>
            </div>
        `;
    }

    return items.map((entry) => `
        <div class="timeline-item">
            <div class="timeline-marker ${entry.type || 'created'}"></div>
            <div class="timeline-content">
                <div class="timeline-title">${(entry.type || 'updated').toUpperCase()}</div>
                <div class="timeline-date">${new Date(entry.timestamp || Date.now()).toLocaleString('pt-BR')}</div>
                <div class="timeline-subtitle">${entry.summary || 'Atualizacao registrada'}${entry.actor ? ` • ${entry.actor}` : ''}</div>
            </div>
        </div>
    `).join('');
}

// ============================================================
// 1. VISUALIZAR DETALHES - Modal Moderno Premium
// ============================================================
function viewRegistrationDetails(regId) {
    const reg = window.currentRegistrations.find(r => r.id === regId);
    if (!reg) return;

    window.currentViewingRegistrationId = regId;

    // Criar modal HTML moderno
    const modalHTML = `
        <div class="modal-backdrop show"></div>
        <div class="modal show registration-detail-modal">
            <div class="modal-content-modern">
                <!-- Header com status -->
                <div class="detail-header">
                    <div class="detail-header-left">
                        <div class="detail-avatar">
                            <i class="fas fa-user"></i>
                        </div>
                        <div>
                            <h2>${reg.clientName || 'Cliente Sem Nome'}</h2>
                            <p class="detail-subtitle">ID: ${reg.id.substring(0, 8)}...</p>
                        </div>
                    </div>
                    <div class="detail-header-right">
                        <span class="status-badge status-${(reg.status || 'pending').toLowerCase()}">
                            ${(reg.status || 'pending').toUpperCase()}
                        </span>
                        <button class="btn-close-modal" onclick="closeDetailModal()">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Conteúdo em seções -->
                <div class="detail-sections">
                    <!-- Seção: Informações Pessoais -->
                    <div class="detail-section">
                        <div class="section-header">
                            <i class="fas fa-id-card"></i>
                            <h3>Informações Pessoais</h3>
                        </div>
                        <div class="section-grid">
                            <div class="info-field">
                                <label>Telefone</label>
                                <div class="info-value">${reg.clientPhone || 'Não cadastrado'}</div>
                            </div>
                            <div class="info-field">
                                <label>Email</label>
                                <div class="info-value">${reg.clientEmail || 'Não cadastrado'}</div>
                            </div>
                            <div class="info-field">
                                <label>CPF/CNPJ</label>
                                <div class="info-value">${reg.document || 'Não cadastrado'}</div>
                            </div>
                            <div class="info-field">
                                <label>JID WhatsApp</label>
                                <div class="info-value info-mono">${reg.clientJid || 'N/A'}</div>
                            </div>
                        </div>
                    </div>

                    <!-- Seção: Plano e Localização -->
                    <div class="detail-section">
                        <div class="section-header">
                            <i class="fas fa-map-pin"></i>
                            <h3>Localização e Plano</h3>
                        </div>
                        <div class="section-grid">
                            <div class="info-field full">
                                <label>Endereço Completo</label>
                                <div class="info-value">${reg.address || 'Não cadastrado'}</div>
                            </div>
                            <div class="info-field">
                                <label>Plano Contratado</label>
                                <div class="info-value">
                                    <span class="plan-badge">${(reg.plan || 'basic').toUpperCase()}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Seção: Informações Adicionais -->
                    ${reg.additionalInfo ? `
                        <div class="detail-section">
                            <div class="section-header">
                                <i class="fas fa-note-sticky"></i>
                                <h3>Informações Adicionais</h3>
                            </div>
                            <div class="info-field full">
                                <div class="info-value">${reg.additionalInfo}</div>
                            </div>
                        </div>
                    ` : ''}

                    <!-- Seção: Timeline -->
                    <div class="detail-section">
                        <div class="section-header">
                            <i class="fas fa-history"></i>
                            <h3>Registros</h3>
                        </div>
                        <div class="timeline">
                            <div class="timeline-item">
                                <div class="timeline-marker created"></div>
                                <div class="timeline-content">
                                    <div class="timeline-title">Cadastro Criado</div>
                                    <div class="timeline-date">${new Date(reg.timestamp).toLocaleString('pt-BR')}</div>
                                </div>
                            </div>
                            ${reg.approvedAt ? `
                                <div class="timeline-item">
                                    <div class="timeline-marker approved"></div>
                                    <div class="timeline-content">
                                        <div class="timeline-title">Cadastro Aprovado</div>
                                        <div class="timeline-date">${new Date(reg.approvedAt).toLocaleString('pt-BR')}</div>
                                        <div class="timeline-subtitle">Por: ${reg.approvedBy || 'Admin'}</div>
                                    </div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </div>

                <!-- Footer com ações -->
                <div class="detail-footer">
                    ${reg.status !== 'approved' ? `
                        <button class="btn btn-success" onclick="approveRegistrationModal('${reg.id}')">
                            <i class="fas fa-check-circle"></i> Aprovar Agora
                        </button>
                    ` : ''}
                    ${reg.status !== 'rejected' ? `
                        <button class="btn btn-warning" onclick="rejectRegistrationModal('${reg.id}')">
                            <i class="fas fa-times-circle"></i> Rejeitar
                        </button>
                    ` : ''}
                    <button class="btn btn-info" onclick="editRegistration('${reg.id}')">
                        <i class="fas fa-edit"></i> Editar
                    </button>
                    <button class="btn btn-danger" onclick="deleteRegistrationModal('${reg.id}')">
                        <i class="fas fa-trash"></i> Excluir
                    </button>
                </div>
            </div>
        </div>
    `;

    // Inserir modal no DOM
    const container = document.createElement('div');
    container.id = 'registration-detail-container';
    container.innerHTML = modalHTML;
    document.body.appendChild(container);

    // Animar entrada
    setTimeout(() => {
        const modal = document.querySelector('.registration-detail-modal');
        if (modal) modal.style.animation = 'slideInUp 0.3s ease-out';
    }, 0);
}

function closeDetailModal() {
    const container = document.getElementById('registration-detail-container');
    if (container) {
        const modal = container.querySelector('.registration-detail-modal');
        if (modal) {
            modal.style.animation = 'slideOutDown 0.3s ease-in';
            setTimeout(() => container.remove(), 300);
        }
    }
    window.currentViewingRegistrationId = null;
}

// ============================================================
// 2. EDITAR CADASTRO - Modal com Formulário Moderno
// ============================================================
function editRegistration(regId) {
    const reg = window.currentRegistrations.find(r => r.id === regId);
    if (!reg) {
        showAlert('Cadastro não encontrado', 'danger');
        return;
    }

    const modalHTML = `
        <div class="modal-backdrop show"></div>
        <div class="modal show registration-edit-modal">
            <div class="modal-content-modern modal-lg">
                <div class="modal-header-modern">
                    <div>
                        <h2>Editar Cadastro</h2>
                        <p class="modal-subtitle">Atualize as informações do cliente</p>
                    </div>
                    <button class="btn-close-modal" onclick="closeEditModal()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <form id="editRegistrationForm" class="registration-form">
                    <!-- Seção 1: Informações Básicas -->
                    <div class="form-section">
                        <h3><i class="fas fa-user-circle"></i> Informações Básicas</h3>
                        <div class="form-grid-2">
                            <div class="form-group">
                                <label for="editClientName">Nome Completo *</label>
                                <input 
                                    type="text" 
                                    id="editClientName" 
                                    class="form-control" 
                                    value="${reg.clientName || ''}"
                                    required
                                    placeholder="Ex: João Silva"
                                >
                            </div>
                            <div class="form-group">
                                <label for="editClientJid">JID WhatsApp *</label>
                                <input 
                                    type="text" 
                                    id="editClientJid" 
                                    class="form-control" 
                                    value="${reg.clientJid || ''}"
                                    required
                                    placeholder="Ex: 5511987654321@s.whatsapp.net"
                                >
                            </div>
                        </div>
                    </div>

                    <!-- Seção 2: Contato -->
                    <div class="form-section">
                        <h3><i class="fas fa-address-book"></i> Informações de Contato</h3>
                        <div class="form-grid-2">
                            <div class="form-group">
                                <label for="editClientPhone">Telefone</label>
                                <input 
                                    type="tel" 
                                    id="editClientPhone" 
                                    class="form-control" 
                                    value="${reg.clientPhone || ''}"
                                    placeholder="Ex: (11) 98765-4321"
                                >
                            </div>
                            <div class="form-group">
                                <label for="editClientEmail">Email</label>
                                <input 
                                    type="email" 
                                    id="editClientEmail" 
                                    class="form-control" 
                                    value="${reg.clientEmail || ''}"
                                    placeholder="Ex: email@exemplo.com"
                                >
                            </div>
                        </div>
                    </div>

                    <!-- Seção 3: Documentos e Localização -->
                    <div class="form-section">
                        <h3><i class="fas fa-file-shield"></i> Documentos e Localização</h3>
                        <div class="form-grid-2">
                            <div class="form-group">
                                <label for="editDocument">CPF/CNPJ</label>
                                <input 
                                    type="text" 
                                    id="editDocument" 
                                    class="form-control" 
                                    value="${reg.document || ''}"
                                    placeholder="Ex: 000.000.000-00 ou 00.000.000/0000-00"
                                >
                            </div>
                            <div class="form-group">
                                <label for="editPlan">Plano *</label>
                                <select id="editPlan" class="form-control" required>
                                    <option value="basic" ${reg.plan === 'basic' ? 'selected' : ''}>Básico</option>
                                    <option value="professional" ${reg.plan === 'professional' ? 'selected' : ''}>Profissional</option>
                                    <option value="restaurant" ${reg.plan === 'restaurant' ? 'selected' : ''}>Restaurante</option>
                                    <option value="service" ${reg.plan === 'service' ? 'selected' : ''}>Serviço</option>
                                    <option value="custom" ${reg.plan === 'custom' ? 'selected' : ''}>Customizado</option>
                                </select>
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="editAddress">Endereço Completo</label>
                            <textarea 
                                id="editAddress" 
                                class="form-control" 
                                rows="2"
                                placeholder="Ex: Rua Principal, 123, AP 456, Bairro, Cidade - Estado"
                            >${reg.address || ''}</textarea>
                        </div>
                    </div>

                    <!-- Seção 4: Status e Informações Adicionais -->
                    <div class="form-section">
                        <h3><i class="fas fa-cog"></i> Status e Observações</h3>
                        <div class="form-grid-2">
                            <div class="form-group">
                                <label for="editStatus">Status</label>
                                <select id="editStatus" class="form-control">
                                    <option value="pending" ${reg.status === 'pending' ? 'selected' : ''}>Pendente</option>
                                    <option value="approved" ${reg.status === 'approved' ? 'selected' : ''}>Aprovado</option>
                                    <option value="rejected" ${reg.status === 'rejected' ? 'selected' : ''}>Rejeitado</option>
                                </select>
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="editAdditionalInfo">Informações Adicionais</label>
                            <textarea 
                                id="editAdditionalInfo" 
                                class="form-control" 
                                rows="3"
                                placeholder="Observações importantes sobre o cadastro..."
                            >${reg.additionalInfo || ''}</textarea>
                        </div>
                    </div>

                    <!-- Footer -->
                    <div class="form-footer">
                        <button type="button" class="btn btn-secondary" onclick="closeEditModal()">
                            <i class="fas fa-times"></i> Cancelar
                        </button>
                        <button type="submit" class="btn btn-primary">
                            <i class="fas fa-save"></i> Salvar Alterações
                        </button>
                    </div>
                </form>
            </div>
        </div>
    `;

    const container = document.createElement('div');
    container.id = 'registration-edit-container';
    container.innerHTML = modalHTML;
    document.body.appendChild(container);

    // Adicionar event listener ao formulário
    document.getElementById('editRegistrationForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveRegistrationEdit(regId);
    });

    setTimeout(() => {
        const modal = document.querySelector('.registration-edit-modal');
        if (modal) modal.style.animation = 'slideInUp 0.3s ease-out';
    }, 0);
}

function closeEditModal() {
    const container = document.getElementById('registration-edit-container');
    if (container) {
        const modal = container.querySelector('.registration-edit-modal');
        if (modal) {
            modal.style.animation = 'slideOutDown 0.3s ease-in';
            setTimeout(() => container.remove(), 300);
        }
    }
}

async function saveRegistrationEdit(regId) {
    try {
        const response = await fetch(`${API_BASE}/registrations/${regId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientName: document.getElementById('editClientName').value,
                clientJid: document.getElementById('editClientJid').value,
                clientEmail: document.getElementById('editClientEmail').value,
                clientPhone: document.getElementById('editClientPhone').value,
                document: document.getElementById('editDocument').value,
                address: document.getElementById('editAddress').value,
                additionalInfo: document.getElementById('editAdditionalInfo').value,
                plan: document.getElementById('editPlan').value,
                status: document.getElementById('editStatus').value
            })
        });

        if (response.ok) {
            showAlert('✅ Cadastro atualizado com sucesso!', 'success');
            closeEditModal();
            closeDetailModal();
            loadRegistrations();
        } else {
            showAlert('❌ Erro ao atualizar cadastro', 'danger');
        }
    } catch (error) {
        console.error('Erro:', error);
        showAlert('❌ Erro ao salvar as alterações', 'danger');
    }
}

// ============================================================
// 3. APROVAR CADASTRO - Modal Moderno
// ============================================================
function approveRegistrationModal(regId) {
    const reg = window.currentRegistrations.find(r => r.id === regId);
    if (!reg) return;

    const modalHTML = `
        <div class="modal-backdrop show"></div>
        <div class="modal show action-modal">
            <div class="modal-content-modern modal-sm">
                <div class="action-icon approve">
                    <i class="fas fa-check-circle"></i>
                </div>
                <h2>Aprovar Cadastro?</h2>
                <p class="action-subtitle">Você está aprovando o cadastro de</p>
                <p class="client-name">${reg.clientName}</p>
                
                <p class="action-info">
                    <i class="fas fa-info-circle"></i>
                    Este cliente receberá uma confirmação via WhatsApp
                </p>

                <div class="action-footer">
                    <button class="btn btn-secondary" onclick="closeActionModal()">
                        <i class="fas fa-times"></i> Cancelar
                    </button>
                    <button class="btn btn-success" onclick="confirmApproveRegistration('${regId}')">
                        <i class="fas fa-check-circle"></i> Confirmar Aprovação
                    </button>
                </div>
            </div>
        </div>
    `;

    const container = document.createElement('div');
    container.id = 'action-modal-container';
    container.innerHTML = modalHTML;
    document.body.appendChild(container);
}

async function confirmApproveRegistration(regId) {
    try {
        const response = await fetch(`${API_BASE}/registrations/${regId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approvedBy: 'admin' })
        });

        if (response.ok) {
            showAlert('✅ Cadastro aprovado com sucesso!', 'success');
            closeActionModal();
            closeDetailModal();
            loadRegistrations();
        } else {
            showAlert('❌ Erro ao aprovar cadastro', 'danger');
        }
    } catch (error) {
        showAlert('❌ Erro ao aprovar cadastro', 'danger');
    }
}

// ============================================================
// 4. REJEITAR CADASTRO - Modal com Motivo
// ============================================================
function rejectRegistrationModal(regId) {
    const reg = window.currentRegistrations.find(r => r.id === regId);
    if (!reg) return;

    const modalHTML = `
        <div class="modal-backdrop show"></div>
        <div class="modal show action-modal">
            <div class="modal-content-modern modal-sm">
                <div class="action-icon reject">
                    <i class="fas fa-times-circle"></i>
                </div>
                <h2>Rejeitar Cadastro?</h2>
                <p class="action-subtitle">Você está rejeitando o cadastro de</p>
                <p class="client-name">${reg.clientName}</p>
                
                <form id="rejectForm" style="width: 100%; margin-top: 20px;">
                    <div class="form-group">
                        <label for="rejectionReason">Motivo da Rejeição *</label>
                        <textarea 
                            id="rejectionReason" 
                            class="form-control" 
                            rows="3"
                            placeholder="Explique por que este cadastro foi rejeitado..."
                            required
                        ></textarea>
                    </div>
                </form>

                <p class="action-info">
                    <i class="fas fa-info-circle"></i>
                    O cliente será notificado do motivo via WhatsApp
                </p>

                <div class="action-footer">
                    <button class="btn btn-secondary" onclick="closeActionModal()">
                        <i class="fas fa-times"></i> Cancelar
                    </button>
                    <button class="btn btn-warning" onclick="confirmRejectRegistration('${regId}')">
                        <i class="fas fa-times-circle"></i> Confirmar Rejeição
                    </button>
                </div>
            </div>
        </div>
    `;

    const container = document.createElement('div');
    container.id = 'action-modal-container';
    container.innerHTML = modalHTML;
    document.body.appendChild(container);
}

async function confirmRejectRegistration(regId) {
    const reason = document.getElementById('rejectionReason').value.trim();
    
    if (!reason) {
        showAlert('⚠️ Por favor, informe um motivo para a rejeição', 'warning');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/registrations/${regId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });

        if (response.ok) {
            showAlert('✅ Cadastro rejeitado com sucesso!', 'success');
            closeActionModal();
            closeDetailModal();
            loadRegistrations();
        } else {
            showAlert('❌ Erro ao rejeitar cadastro', 'danger');
        }
    } catch (error) {
        showAlert('❌ Erro ao rejeitar cadastro', 'danger');
    }
}

// ============================================================
// 5. DELETAR CADASTRO - Modal de Confirmação
// ============================================================
function deleteRegistrationModal(regId) {
    const reg = window.currentRegistrations.find(r => r.id === regId);
    if (!reg) return;

    const modalHTML = `
        <div class="modal-backdrop show"></div>
        <div class="modal show action-modal">
            <div class="modal-content-modern modal-sm">
                <div class="action-icon delete">
                    <i class="fas fa-trash-alt"></i>
                </div>
                <h2>Excluir Cadastro?</h2>
                <p class="action-subtitle">Esta ação não pode ser desfeita!</p>
                <p class="client-name">${reg.clientName}</p>
                
                <p class="action-warning">
                    <i class="fas fa-exclamation-triangle"></i>
                    Todos os dados deste cadastro serão permanentemente removidos
                </p>

                <div style="margin-top: 20px; padding: 12px; background: rgba(244, 67, 54, 0.05); border-radius: 8px; border-left: 3px solid #f44336;">
                    <strong style="color: #f44336;">Atenção:</strong> Deletar este cadastro é irreversível. Certifique-se de que deseja continuar.
                </div>

                <div class="action-footer">
                    <button class="btn btn-secondary" onclick="closeActionModal()">
                        <i class="fas fa-times"></i> Cancelar
                    </button>
                    <button class="btn btn-danger" onclick="confirmDeleteRegistration('${regId}')">
                        <i class="fas fa-trash-alt"></i> Excluir Permanentemente
                    </button>
                </div>
            </div>
        </div>
    `;

    const container = document.createElement('div');
    container.id = 'action-modal-container';
    container.innerHTML = modalHTML;
    document.body.appendChild(container);
}

async function confirmDeleteRegistration(regId) {
    try {
        const response = await fetch(`${API_BASE}/registrations/${regId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            showAlert('✅ Cadastro excluído com sucesso!', 'success');
            closeActionModal();
            closeDetailModal();
            
            // Aguarda um pouco e recarrega os dados
            setTimeout(() => {
                loadRegistrations();
                // Força refresh completo se necessário
                window.location.reload();
            }, 500);
        } else {
            const errorData = await response.json().catch(() => ({}));
            showAlert(`❌ Erro ao excluir cadastro: ${errorData.message || 'Tente novamente'}`, 'danger');
        }
    } catch (error) {
        console.error('Erro ao excluir cadastro:', error);
        showAlert('❌ Erro ao excluir cadastro: ' + error.message, 'danger');
    }
}

function closeActionModal() {
    const container = document.getElementById('action-modal-container');
    if (container) {
        const modal = container.querySelector('.action-modal');
        if (modal) {
            modal.style.animation = 'slideOutDown 0.3s ease-in';
            setTimeout(() => container.remove(), 300);
        }
    }
}
