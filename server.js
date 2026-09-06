import express from 'express';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const cleanReg = (value='') => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

async function fetchDvla(registration) {
  if (!process.env.DVLA_API_KEY) return null;
  const res = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.DVLA_API_KEY
    },
    body: JSON.stringify({ registrationNumber: registration })
  });
  if (!res.ok) throw new Error(`DVLA error ${res.status}`);
  return res.json();
}

let motToken = null;
let motTokenExpiresAt = 0;
async function getMotToken() {
  if (motToken && Date.now() < motTokenExpiresAt - 60_000) return motToken;
  const { DVSA_CLIENT_ID, DVSA_CLIENT_SECRET, DVSA_SCOPE, DVSA_TOKEN_URL } = process.env;
  if (!DVSA_CLIENT_ID || !DVSA_CLIENT_SECRET || !DVSA_SCOPE || !DVSA_TOKEN_URL) return null;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: DVSA_CLIENT_ID,
    client_secret: DVSA_CLIENT_SECRET,
    scope: DVSA_SCOPE
  });
  const res = await fetch(DVSA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`DVSA token error ${res.status}`);
  const data = await res.json();
  motToken = data.access_token;
  motTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return motToken;
}

async function fetchMot(registration) {
  if (!process.env.DVSA_API_KEY) return null;
  const token = await getMotToken();
  if (!token) return null;
  const res = await fetch(`https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(registration)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-API-Key': process.env.DVSA_API_KEY,
      Accept: 'application/json'
    }
  });
  if (!res.ok) throw new Error(`DVSA MOT error ${res.status}`);
  return res.json();
}

function demoReport(reg) {
  return {
    registrationNumber: reg,
    make: 'DEMO',
    model: 'Vehicle',
    colour: 'Black',
    fuelType: 'PETROL',
    engineCapacity: 1598,
    yearOfManufacture: 2018,
    monthOfFirstRegistration: '2018-06',
    taxStatus: 'Taxed',
    taxDueDate: '2027-01-01',
    motStatus: 'Valid',
    motExpiryDate: '2027-03-18',
    co2Emissions: 129,
    markedForExport: false,
    wheelplan: '2 AXLE RIGID BODY',
    typeApproval: 'M1',
    revenueWeight: 0
  };
}

app.post('/api/check', async (req, res) => {
  const registration = cleanReg(req.body.registration);
  if (registration.length < 2 || registration.length > 8) {
    return res.status(400).json({ error: 'Enter a valid UK registration.' });
  }

  try {
    const [dvlaResult, motResult] = await Promise.allSettled([
      fetchDvla(registration),
      fetchMot(registration)
    ]);

    const dvla = dvlaResult.status === 'fulfilled' ? dvlaResult.value : null;
    const mot = motResult.status === 'fulfilled' ? motResult.value : null;
    const usingDemo = !dvla;

    res.json({
      source: usingDemo ? 'demo' : 'live',
      vehicle: dvla || demoReport(registration),
      mot,
      checks: {
        insurance: { status: 'NOT_CHECKED', note: 'Requires authorised insurance/MID data access.' },
        finance: { status: 'NOT_CHECKED', note: 'Requires a licensed commercial vehicle-history provider.' },
        stolen: { status: 'NOT_CHECKED', note: 'Requires an approved provenance data provider.' },
        writeOff: { status: 'NOT_CHECKED', note: 'Requires an approved insurance/provenance data provider.' },
        keeperHistory: { status: 'NOT_CHECKED', note: 'Not included in the basic DVLA Vehicle Enquiry API.' },
        valuation: { status: 'NOT_CHECKED', note: 'Requires a valuation data provider.' }
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Unable to retrieve vehicle information.', detail: err.message });
  }
});

app.listen(PORT, () => console.log(`Akar's Car Check running at http://localhost:${PORT}`));
