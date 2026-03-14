import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const USERNAME = process.env.APP_USERNAME || "studentnurse";
const PASSWORD = process.env.APP_PASSWORD || "ilovedora";

app.use(express.json({ limit: "400kb" }));
app.use(helmet());
app.use(cors());

const sessions = new Map();

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20
});

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();

  if (!sessions.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const session = sessions.get(token);
  session.lastSeen = Date.now();
  sessions.set(token, session);

  next();
}

function cleanText(text, limit = 1500) {
  return (text || "").toString().trim().slice(0, limit);
}

function cleanArray(arr, itemLimit = 300, maxItems = 10) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(item => cleanText(item, itemLimit))
    .filter(Boolean)
    .slice(0, maxItems);
}

function validateCaseInput(body) {
  if (!body) {
    return { ok: false, error: "Missing request body" };
  }

  return {
    ok: true,
    data: {
      age: cleanText(body.age, 50),
      sex: cleanText(body.sex, 50),
      chiefComplaint: cleanText(body.chiefComplaint, 300),
      admittingDiagnosis: cleanText(body.admittingDiagnosis, 300),
      history: cleanText(body.history, 1500),
      subjectiveData: cleanText(body.subjectiveData, 2000),
      objectiveData: cleanText(body.objectiveData, 2000),
      temperature: cleanText(body.temperature, 50),
      bloodPressure: cleanText(body.bloodPressure, 50),
      heartRate: cleanText(body.heartRate, 50),
      respiratoryRate: cleanText(body.respiratoryRate, 50),
      oxygenSaturation: cleanText(body.oxygenSaturation, 50),
      medications: Array.isArray(body.medications) ? body.medications.slice(0, 20) : []
    }
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, aiReady: true });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username !== USERNAME || password !== PASSWORD) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = crypto.randomUUID();
  sessions.set(token, { createdAt: Date.now(), lastSeen: Date.now() });

  res.json({ token });
});

app.post("/logout", authMiddleware, (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();
  sessions.delete(token);
  res.json({ ok: true });
});

app.post("/generate-ncp", authMiddleware, aiLimiter, async (req, res) => {
  const validation = validateCaseInput(req.body);

  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  const clinicalData = validation.data;

  try {
    const prompt = `
You are assisting with an educational nursing care plan.

Follow these rules strictly:
1. Use only the data provided.
2. Do not invent unsupported facts.
3. Generate TOP 3 possible NANDA nursing diagnoses in order of best fit.
4. Each diagnosis must be nursing-style and clinically grounded.
5. Select ONE primary diagnosis from the top 3.
6. When supported by the case, write the primary diagnosis in this form:
   "Problem related to [related factors] secondary to [condition if clearly supported] as evidenced by [signs/symptoms/cues]"
7. If "secondary to" is not supported, omit it.
8. If "as evidenced by" is not supported, omit it.
9. Provide NOC outcomes and NIC interventions.
10. Provide implementation suggestions based on the case and listed medications, but do not prescribe new medications.
11. Short-term goal must begin exactly with:
   "At the end of the 8 hour shift..."
12. Long-term goal must begin exactly with:
   "After"
13. Return VALID JSON only.
14. No markdown. No code fences.

JSON keys must be exactly:
topDiagnoses
primaryDiagnosis
rationaleNotes
nocOutcomes
nicInterventions
implementationSuggestions
shortTermGoal
longTermGoal

Value rules:
- topDiagnoses: array of exactly 3 strings
- primaryDiagnosis: string
- rationaleNotes: string
- nocOutcomes: array of 3 to 6 strings
- nicInterventions: array of 4 to 8 strings
- implementationSuggestions: array of 4 to 8 strings
- shortTermGoal: string
- longTermGoal: string

Clinical data:
${JSON.stringify(clinicalData, null, 2)}
`;

    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3.2:3b",
        prompt,
        stream: false,
        format: "json"
      })
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: `Local AI generation failed: ${text}` });
    }

    const data = await response.json();
    const parsed = JSON.parse(data.response || "{}");

    let topDiagnoses = cleanArray(parsed.topDiagnoses, 260, 3);

    if (topDiagnoses.length < 3) {
      const primary = cleanText(parsed.primaryDiagnosis, 500);
      const fallback1 = primary || "Review assessment cues for a primary NANDA diagnosis";
      const fallback2 = "Risk for complications related to current clinical condition";
      const fallback3 = "Further focused assessment may support another NANDA diagnosis";
      topDiagnoses = [fallback1, fallback2, fallback3].slice(0, 3);
    }

    let primaryDiagnosis = cleanText(parsed.primaryDiagnosis || topDiagnoses[0], 800);
    if (!primaryDiagnosis) {
      primaryDiagnosis = topDiagnoses[0];
    }

    res.json({
      topDiagnoses,
      primaryDiagnosis,
      rationaleNotes: cleanText(parsed.rationaleNotes, 1500),
      nocOutcomes: cleanArray(parsed.nocOutcomes, 280, 6),
      nicInterventions: cleanArray(parsed.nicInterventions, 320, 8),
      implementationSuggestions: cleanArray(parsed.implementationSuggestions, 320, 8),
      shortTermGoal: cleanText(parsed.shortTermGoal, 900),
      longTermGoal: cleanText(parsed.longTermGoal, 900)
    });
  } catch (error) {
    console.error("Local AI error:", error);
    res.status(500).json({
      error: error?.message || "Local AI generation failed"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Secure NCP backend listening on http://localhost:${PORT}`);
});