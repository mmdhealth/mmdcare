# MMDConnect Care Provider (QR-less)

A streamlined care-provider portal that lets clinicians authenticate with BankID (or a built‑in test login), select a patient from a curated list, and monitor real‑time uploads sent from the companion mobile experience. The current build removes the QR-only workflow and always starts with the login + patient selector UI.

## 🚀 Features

- **BankID & Test Login**: Dual login options so the platform is accessible during demos.
- **Patient Selector**: Pick Anders, Markus, or Samuel and automatically provision a clean transfer channel.
- **Secure File Transfer**: Real-time status plus automatic cleanup of legacy uploads per patient.
- **Multiple File Types**: PDF and Excel (XLSX) ingestion with structured parsing.
- **Healthcare Dashboard**: Organ overview, lab summaries, GPT helper, and more.

## 📱 How It Works (Current Flow)

1. **Login**: Provider visits `login.html`, chooses BankID or the “Testa inloggning” button.
2. **Patient Selection**: After auth the user lands on `index.html`, selects a patient, and the app creates a brand-new transfer session.
3. **Waiting State**: A notification indicates “Väntar på uppladdning <patient>” while `/api/complete` is polled.
4. **Upload Detection**: Once files arrive, the dashboard opens, clears stale data, and displays the latest PDFs/XLSX contents.
5. **Dashboard**: Providers review journal entries, labs, GPT summaries, and linked organ modules.

## 🛠️ Technology Stack

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Backend**: Node.js with Vercel Serverless Functions
- **File Upload**: Formidable for handling multipart/form-data
- **Storage**: Vercel Blob for file storage
- **Real-time**: Server-Sent Events (SSE) and polling
- **PDF Processing**: pdf-parse for document analysis
- **Excel Processing**: xlsx (SheetJS) for spreadsheet parsing
- **Charts**: Chart.js for data visualization

## 🚀 Quick Deployment

### Option 1: Vercel (Recommended)

1. **Fork this repository** to your GitHub account
2. **Sign up** at [vercel.com](https://vercel.com)
3. **Import project** from GitHub
4. **Deploy** - Vercel will automatically detect the Node.js configuration

The app will be available at: `https://your-project-name.vercel.app`

### Option 2: Netlify

1. **Fork this repository** to your GitHub account
2. **Sign up** at [netlify.com](https://netlify.com)
3. **New site from Git** → Connect GitHub repository
4. **Deploy** - Netlify will use the `netlify.toml` configuration

The app will be available at: `https://your-project-name.netlify.app`

### Option 3: Railway

1. **Fork this repository** to your GitHub account
2. **Sign up** at [railway.app](https://railway.app)
3. **New Project** → Deploy from GitHub repo
4. **Deploy** - Railway automatically detects Node.js

## 🏃‍♂️ Local Development

1. **Clone the repository**:
   ```bash
   git clone https://github.com/mmdhealth/mmdcare.git
   cd mmdcare
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the development server**:
   ```bash
   npm run dev
   ```

4. **Access the application**:
   - Login page: `http://localhost:3000/login.html`
   - Patient list: `http://localhost:3000/index.html`

## 📁 Project Structure

```
mmdcaremobile/
├── Assets/                 # Static assets (images, icons)
├── netlify/               # Netlify deployment configuration
│   └── functions/         # Serverless functions
├── uploads/               # Uploaded files (excluded from git)
├── login.html           # BankID + test login entry point
├── index.html           # Patient selector + transfer creation
├── dashboard.html       # Healthcare provider dashboard
├── transfer-server.js    # Main Node.js server
├── package.json          # Dependencies and scripts
├── vercel.json          # Vercel deployment config
├── netlify.toml         # Netlify deployment config
└── README.md            # This file
```

## 🔧 Configuration

### Environment Variables

- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Environment (development/production)

### File Upload Limits

- **Maximum file size**: 100 MB per file
- **Supported formats**: PDF, XLSX
- **Storage**: Local filesystem (uploads directory)

## 🔒 Security Features

- **File type validation**: Only PDF and XLSX files allowed
- **Size limits**: 100 MB maximum per file
- **Temporary storage**: Files are stored temporarily and cleaned up
- **CORS enabled**: Cross-origin requests properly handled
- **Input sanitization**: File names and metadata sanitized

## 📱 Mobile Compatibility

- **Responsive design**: Works on all mobile devices
- **Touch-friendly**: Large buttons and touch targets
- **Camera integration**: QR code scanning via device camera
- **File picker**: Native file selection on mobile devices

## 🏥 Healthcare Integration

### PDF Parsing
- **Automatic extraction**: Parses medical document content automatically
- **Structured data**: Organizes Swedish medical documents into sections
- **Metadata extraction**: Extracts doctor names, dates, and document types
- **Dashboard integration**: Seamlessly displays documents in the healthcare dashboard

### Excel (XLSX) Parsing for Heart Data
- **Heart metrics extraction**: Automatically identifies and extracts:
  - Heart rate (Hjärtfrekvens / Heart Rate)
  - Systolic blood pressure (Systoliskt blodtryck)
  - Diastolic blood pressure (Diastoliskt blodtryck)
  - Cholesterol LDL (Kolesterol)
- **Time series data**: Supports heart rate measurements over time for trend analysis
- **Visual display**: Replaces mock data in the Heart (Hjärta) page with actual patient data
- **Smart fallback**: Shows "Ingen data finns" for missing data points while displaying available information
- **Flexible format**: Supports both Swedish and English column headers
- **Multi-sheet support**: Reads data from multiple sheets in the same Excel file

For detailed information on Excel file format requirements, see [EXCEL_FORMAT_GUIDE.md](EXCEL_FORMAT_GUIDE.md)

## 🐛 Troubleshooting

### Common Issues

1. **Still seeing the QR UI**: Clear browser cache + localStorage (`localStorage.clear()` in DevTools) to force the new login flow.
2. **File upload fails**: Check file size and format (PDF/XLSX only).
3. **Connection issues**: Verify network connectivity and server status.

### Development Issues

1. **Port conflicts**: Change the PORT environment variable
2. **File permissions**: Ensure write permissions for uploads directory
3. **Dependencies**: Run `npm install` to install all required packages

## 📄 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📞 Support

For support and questions:
- Create an issue in this repository
- Contact: [Your contact information]

---

**MMDConnect** - Secure healthcare document sharing made simple.