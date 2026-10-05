import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const cleanReg = (value = '') => String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');

async function fetchDvla(registration) {
  if (!process.env.DVLA_API_KEY) {
    throw new Error('DVLA_API_KEY is not configured');
  }

  const response = await fetch(
    'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.DVLA_API_KEY,
      },
      body: JSON.stringify({ registrationNumber: registration }),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`DVLA error ${response.status}${text ? `: ${text}` : ''}`);
  }

  return response.json();
}

let motToken = null;
let motTokenExpiresAt = 0;

async function getMotToken() {
  if (motToken && Date.now() < motTokenExpiresAt - 60_000) {
    return motToken;
  }

  const {
    DVSA_CLIENT_ID,
    DVSA_CLIENT_SECRET,
    DVSA_SCOPE,
    DVSA_TOKEN_URL,
  } = process.env;

  if (!DVSA_CLIENT_ID) throw new Error('DVSA_CLIENT_ID is not configured');
  if (!DVSA_CLIENT_SECRET) throw new Error('DVSA_CLIENT_SECRET is not configured');
  if (!DVSA_SCOPE) throw new Error('DVSA_SCOPE is not configured');
  if (!DVSA_TOKEN_URL) throw new Error('DVSA_TOKEN_URL is not configured');

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: DVSA_CLIENT_ID,
    client_secret: DVSA_CLIENT_SECRET,
    scope: DVSA_SCOPE,
  });

  const response = await fetch(DVSA_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`DVSA token error ${response.status}${text ? `: ${text}` : ''}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error('DVSA token response did not contain an access token');
  }

  motToken = data.access_token;
  motTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;

  return motToken;
}

async function fetchMot(registration) {
  if (!process.env.DVSA_API_KEY) {
    throw new Error('DVSA_API_KEY is not configured');
  }

  const token = await getMotToken();

  const response = await fetch(
    `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(registration)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-API-Key': process.env.DVSA_API_KEY,
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`DVSA MOT error ${response.status}${text ? `: ${text}` : ''}`);
  }

  return response.json();
}

function extractMotTests(motData) {
  if (!motData) return [];

  if (Array.isArray(motData)) {
    if (motData.length === 1 && Array.isArray(motData[0]?.motTests)) {
      return motData[0].motTests;
    }
    if (motData.every(item => item && typeof item === 'object' && !('motTests' in item))) {
      return motData;
    }
  }

  if (Array.isArray(motData.motTests)) return motData.motTests;
  if (Array.isArray(motData.tests)) return motData.tests;

  return [];
}

function normaliseMotHistory(motData) {
  const tests = extractMotTests(motData);

  return tests.map((test) => ({
    completedDate: test.completedDate ?? test.testDate ?? null,
    testResult: test.testResult ?? test.result ?? null,
    expiryDate: test.expiryDate ?? null,
    odometerValue: test.odometerValue ?? test.odometer?.value ?? null,
    odometerUnit: test.odometerUnit ?? test.odometer?.unit ?? null,
    motTestNumber: test.motTestNumber ?? test.testNumber ?? null,
    defects: Array.isArray(test.defects)
      ? test.defects.map((defect) => ({
          text: defect.text ?? defect.description ?? '',
          type: defect.type ?? defect.defectType ?? null,
          dangerous: defect.dangerous ?? null,
        }))
      : [],
  }));
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    dvlaConfigured: Boolean(process.env.DVLA_API_KEY),
    dvsaConfigured: Boolean(
      process.env.DVSA_API_KEY &&
      process.env.DVSA_CLIENT_ID &&
      process.env.DVSA_CLIENT_SECRET &&
      process.env.DVSA_SCOPE &&
      process.env.DVSA_TOKEN_URL
    ),
  });
});

app.post('/api/check', async (req, res) => {
  const registration = cleanReg(req.body?.registration);

  if (registration.length < 2 || registration.length > 8) {
    return res.status(400).json({ error: 'Enter a valid UK registration.' });
  }

  const [dvlaResult, motResult] = await Promise.allSettled([
    fetchDvla(registration),
    fetchMot(registration),
  ]);

  const vehicle = dvlaResult.status === 'fulfilled' ? dvlaResult.value : null;
  const mot = motResult.status === 'fulfilled' ? motResult.value : null;
  const motHistory = normaliseMotHistory(mot);

  if (!vehicle && !mot) {
    return res.status(502).json({
      error: 'Unable to retrieve vehicle information.',
      registration,
      dvlaError: dvlaResult.status === 'rejected' ? dvlaResult.reason?.message : null,
      dvsaError: motResult.status === 'rejected' ? motResult.reason?.message : null,
    });
  }

  return res.json({
    source: 'live',
    registration,
    vehicle,
    mot,
    motHistory,
    motHistoryCount: motHistory.length,
    services: {
      dvla: {
        ok: Boolean(vehicle),
        error: dvlaResult.status === 'rejected' ? dvlaResult.reason?.message : null,
      },
      dvsaMotHistory: {
        ok: Boolean(mot),
        error: motResult.status === 'rejected' ? motResult.reason?.message : null,
      },
    },
    checks: {
      insurance: {
        status: 'NOT_CHECKED',
        note: 'Requires authorised insurance/MID data access.',
      },
      finance: {
        status: 'NOT_CHECKED',
        note: 'Requires a licensed commercial vehicle-history provider.',
      },
      stolen: {
        status: 'NOT_CHECKED',
        note: 'Requires an approved provenance data provider.',
      },
      writeOff: {
        status: 'NOT_CHECKED',
        note: 'Requires an approved insurance/provenance data provider.',
      },
      keeperHistory: {
        status: 'NOT_CHECKED',
        note: 'Not included in the basic DVLA Vehicle Enquiry API.',
      },
      valuation: {
        status: 'NOT_CHECKED',
        note: 'Requires a valuation data provider.',
      },
    },
  });
});

app.listen(PORT, () => {
  console.log(`Akar's Car Check running on port ${PORT}`);
});
