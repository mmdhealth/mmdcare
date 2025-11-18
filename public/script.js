function getStoredPatientName() {
    const name = localStorage.getItem('currentPatientName');
    if (!name || !name.trim()) {
        return 'Patient';
    }
    return name;
}

function getStoredPatientFirstName() {
    const fullName = getStoredPatientName();
    const first = fullName.split(' ')[0];
    return first || fullName;
}

function applyPatientNameLabels() {
    const fullName = getStoredPatientName();
    const firstName = getStoredPatientFirstName();
    document.querySelectorAll('[data-patient-name="full"]').forEach(el => {
        el.textContent = fullName;
    });
    document.querySelectorAll('[data-patient-name="first"]').forEach(el => {
        el.textContent = firstName;
    });
}

window.getStoredPatientName = getStoredPatientName;
window.getStoredPatientFirstName = getStoredPatientFirstName;

document.addEventListener('DOMContentLoaded', applyPatientNameLabels);

// Mobile menu functionality
document.addEventListener('DOMContentLoaded', function() {
    // Add mobile menu toggle button
    const contentHeader = document.querySelector('.content-header');
    const sidebar = document.querySelector('.sidebar');
    
    // Check if required elements exist
    if (!contentHeader || !sidebar) {
        console.log('Required elements not found, skipping mobile menu setup');
        return;
    }
    
    // Create mobile menu button
    const mobileMenuButton = document.createElement('button');
    mobileMenuButton.className = 'mobile-menu-button';
    mobileMenuButton.innerHTML = '☰';
    mobileMenuButton.style.cssText = `
        display: none;
        background: none;
        border: none;
        font-size: 24px;
        cursor: pointer;
        padding: 8px;
        margin-right: 16px;
    `;
    
    // Insert mobile menu button safely
    const headerTitle = contentHeader.querySelector('h1');
    if (headerTitle && headerTitle.parentNode === contentHeader) {
        contentHeader.insertBefore(mobileMenuButton, headerTitle);
    } else {
        // Fallback: append to the beginning of contentHeader
        contentHeader.insertBefore(mobileMenuButton, contentHeader.firstChild);
    }
    
    // Toggle sidebar on mobile
    mobileMenuButton.addEventListener('click', function() {
        sidebar.classList.toggle('open');
    });
    
    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', function(event) {
        if (window.innerWidth <= 768) {
            if (!sidebar.contains(event.target) && !mobileMenuButton.contains(event.target)) {
                sidebar.classList.remove('open');
            }
        }
    });
    
    // Handle window resize
    window.addEventListener('resize', function() {
        if (window.innerWidth > 768) {
            sidebar.classList.remove('open');
            mobileMenuButton.style.display = 'none';
        } else {
            mobileMenuButton.style.display = 'block';
        }
    });
    
    // Initial check for mobile
    if (window.innerWidth <= 768) {
        mobileMenuButton.style.display = 'block';
    }
    
    // Navigation item click handlers
    const navItems = document.querySelectorAll('.nav-item');
    console.log('Found nav items:', navItems.length); // Debug log
    navItems.forEach(item => {
        item.addEventListener('click', function() {
            // Remove active class from all items
            navItems.forEach(nav => nav.classList.remove('active'));
            // Add active class to clicked item
            this.classList.add('active');
            
            // Close mobile menu after selection
            if (window.innerWidth <= 768) {
                sidebar.classList.remove('open');
            }
            
            // Navigate to appropriate page based on nav text
            const navText = this.querySelector('.nav-text').textContent.trim();
            console.log('Navigation clicked:', navText); // Debug log
            switch(navText) {
                case 'Översikt':
                    window.location.href = 'dashboard.html';
                    break;
                case 'Journaldata':
                    // Journaldata doesn't have a separate page yet, could add one
                    break;
                case 'Hälsa+ GPT':
                    window.location.href = 'gpt-chat.html';
                    break;
                case 'Hjälp':
                    // Help page doesn't exist yet, could add one
                    break;
                case 'Inställningar':
                    // Settings page doesn't exist yet, could add one
                    break;
                case 'Avsluta':
                    // Logout functionality - show overlay instead of confirm
                    console.log('Logout clicked'); // Debug log
                    showLogoutOverlay();
                    break;
            }
        });
    });
    
    // Add smooth scrolling for better UX
    document.documentElement.style.scrollBehavior = 'smooth';
    
});

// Logout overlay functions (global scope)
function showLogoutOverlay() {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'logout-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;
        
        // Create modal
        const modal = document.createElement('div');
        modal.className = 'logout-modal';
        modal.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 32px;
            max-width: 400px;
            width: 90%;
            text-align: center;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
            transform: scale(0.9);
            transition: transform 0.3s ease;
        `;
        
        modal.innerHTML = `
            <div class="logout-modal-content">
                <div class="logout-info-card">
                    <h4 class="logout-info-title">Logga ut</h4>
                    <p class="logout-info-text">Är du säker på att du vill logga ut från MMDCare?</p>
                    <p class="logout-info-text" style="margin-top: 12px; font-style: italic; color: #999;">Du kommer att behöva logga in igen för att komma åt plattformen.</p>
                </div>
            </div>
            <div class="logout-modal-actions">
                <button class="logout-btn-cancel" onclick="closeLogoutOverlay()">Avbryt</button>
                <button class="logout-btn-confirm" onclick="confirmLogout()">Logga ut</button>
            </div>
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        // Animate in
        setTimeout(() => {
            overlay.style.opacity = '1';
            modal.style.transform = 'scale(1)';
        }, 10);
        
        // Close on overlay click
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                closeLogoutOverlay();
            }
        });
        
        // Close on escape key
        document.addEventListener('keydown', handleLogoutEscapeKey);
}

function closeLogoutOverlay() {
        const overlay = document.querySelector('.logout-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            const modal = overlay.querySelector('.logout-modal');
            modal.style.transform = 'scale(0.9)';
            setTimeout(() => {
                overlay.remove();
            }, 300);
        }
        document.removeEventListener('keydown', handleLogoutEscapeKey);
}

function handleLogoutEscapeKey(e) {
        if (e.key === 'Escape') {
            closeLogoutOverlay();
        }
}

async function confirmLogout() {
        const button = document.querySelector('.logout-btn-confirm');
        const originalText = button.textContent;
        
        // Show loading state
        button.textContent = 'Loggar ut...';
        button.disabled = true;
        
        // Clear all transfers on the server
        try {
            const response = await fetch('/api/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (response.ok) {
                console.log('Server transfers cleared');
            } else {
                console.error('Failed to clear server transfers');
            }
        } catch (error) {
            console.error('Error clearing server transfers:', error);
        }
        
        // Clear all session and patient data
        localStorage.removeItem('currentTransferId');
        localStorage.removeItem('currentPatientName');
        localStorage.removeItem('hasSeenLogin');
        localStorage.removeItem('mmdcare_auth');
        localStorage.removeItem('uploadedFiles');
        
        // Clear all patient transfer mappings
        const patientIds = ['anders-boman', 'markus-selin', 'samuel-oldmark'];
        patientIds.forEach(patientId => {
            const transferId = localStorage.getItem(`patient_transfer_${patientId}`);
            if (transferId) {
                localStorage.removeItem(`transfer_patient_${transferId}`);
                localStorage.removeItem(`patient_transfer_${patientId}`);
                localStorage.removeItem(`mmd_files_${transferId}`);
            }
        });
        
        // Clear any remaining transfer-related data
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('mmd_files_') || 
                key.startsWith('transfer_patient_') || 
                key.startsWith('patient_transfer_')) {
                localStorage.removeItem(key);
            }
        });
        
        // Simulate logout process
        setTimeout(() => {
            window.location.href = 'login.html';
        }, 1000);
}

// Add loading animation for organ items
document.addEventListener('DOMContentLoaded', function() {
    const organItems = document.querySelectorAll('.organ-item');
    organItems.forEach((item, index) => {
        item.style.opacity = '0';
        item.style.transform = 'translateY(20px)';
        
        setTimeout(() => {
            item.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
            item.style.opacity = '1';
            item.style.transform = 'translateY(0)';
        }, index * 150);
    });
});

// Journal entry expansion functionality
function toggleJournalEntry(entry) {
    const details = entry.querySelector('.journal-details');
    
    if (details.classList.contains('expanded')) {
        // Collapse current entry
        details.classList.remove('expanded');
        entry.classList.remove('expanded');
    } else {
        // First, collapse all other expanded entries
        const allEntries = document.querySelectorAll('.journal-entry');
        allEntries.forEach(otherEntry => {
            if (otherEntry !== entry) {
                const otherDetails = otherEntry.querySelector('.journal-details');
                if (otherDetails && otherDetails.classList.contains('expanded')) {
                    otherDetails.classList.remove('expanded');
                    otherEntry.classList.remove('expanded');
                }
            }
        });
        
        // Then expand the clicked entry
        details.classList.add('expanded');
        entry.classList.add('expanded');
    }
}

// GPT summarization functionality
function summarizeWithGPT(button) {
    const entry = button.closest('.journal-entry');
    const title = entry.querySelector('.journal-title').textContent;
    const doctor = entry.querySelector('.journal-doctor').textContent;
    const date = entry.querySelector('.journal-date').textContent;
    const summary = entry.querySelector('.journal-summary').textContent;
    
    // Extract detailed content
    const details = entry.querySelector('.journal-content-detail');
    let detailedContent = '';
    if (details) {
        const sections = details.querySelectorAll('h4');
        sections.forEach(section => {
            const sectionTitle = section.textContent;
            const sectionContent = section.nextElementSibling;
            if (sectionContent) {
                detailedContent += `\n\n**${sectionTitle}**\n`;
                if (sectionContent.tagName === 'UL') {
                    const items = sectionContent.querySelectorAll('li');
                    items.forEach(item => {
                        detailedContent += `• ${item.textContent}\n`;
                    });
                } else {
                    detailedContent += sectionContent.textContent + '\n';
                }
            }
        });
    }
    
    // Create the full journal content for summarization with better structure
    const journalContent = `# ${title}

### Läkare
${doctor}

### Datum
${date}

### Sammanfattning
${summary}${detailedContent}

---
*Denna sammanfattning har genererats av Hälsa+GPT baserat på journalanteckningen.*`;
    
    // Show loading state
    const originalText = button.textContent;
    button.textContent = 'Summerar...';
    button.disabled = true;
    
    // Store the journal content in localStorage for the GPT chat
    localStorage.setItem('pendingJournalSummary', JSON.stringify({
        title: title,
        content: journalContent,
        timestamp: new Date().toISOString()
    }));
    
    // Simulate API call and redirect
    setTimeout(() => {
        // Reset button
        button.textContent = originalText;
        button.disabled = false;
        
        // Redirect to GPT chat
        window.location.href = 'gpt-chat.html';
    }, 1500);
}
