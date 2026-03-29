import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const USERNAME = process.env.APP_USERNAME || "studentnurse";
const PASSWORD = process.env.APP_PASSWORD || "ilovedora";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json({ limit: "450kb" }));
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

function sanitizeMedications(meds) {
  if (!Array.isArray(meds)) return [];
  return meds.slice(0, 20).map(med => ({
    name: cleanText(med?.name, 120),
    dose: cleanText(med?.dose, 80),
    route: cleanText(med?.route, 60),
    frequency: cleanText(med?.frequency, 80),
    time: cleanText(med?.time, 80),
    type: cleanText(med?.type, 40)
  })).filter(m =>
    m.name || m.dose || m.route || m.frequency || m.time || m.type
  );
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
      patientReceivedCondition: cleanText(body.patientReceivedCondition, 1200),
      subjectiveData: cleanText(body.subjectiveData, 2200),
      objectiveData: cleanText(body.objectiveData, 2200),

      temperature: cleanText(body.temperature, 50),
      bloodPressure: cleanText(body.bloodPressure, 50),
      heartRate: cleanText(body.heartRate, 50),
      respiratoryRate: cleanText(body.respiratoryRate, 50),
      oxygenSaturation: cleanText(body.oxygenSaturation, 50),

      fhr: cleanText(body.fhr, 50),
      contractionType: cleanText(body.contractionType, 100),
      contractionIntensity: cleanText(body.contractionIntensity, 100),
      contractionFrequency: cleanText(body.contractionFrequency, 100),
      contractionDuration: cleanText(body.contractionDuration, 100),

      bishopPosition: cleanText(body.bishopPosition, 20),
      bishopConsistency: cleanText(body.bishopConsistency, 20),
      bishopEffacement: cleanText(body.bishopEffacement, 20),
      bishopDilation: cleanText(body.bishopDilation, 20),
      bishopStation: cleanText(body.bishopStation, 20),
      bishopScore: cleanText(body.bishopScore, 20),

      medications: sanitizeMedications(body.medications)
    }
  };
}

function ensureEtiology(primaryDiagnosis) {
  const dx = cleanText(primaryDiagnosis, 800);
  const lower = dx.toLowerCase();

  const hasEtiology =
    lower.includes(" related to ") ||
    lower.includes(" r/t ") ||
    lower.includes("secondary to");

  if (hasEtiology) return dx;

  return `${dx} related to insufficient supporting data for exact etiologic statement`;
}

function fallbackInterventions(arr, type) {
  if (Array.isArray(arr) && arr.length > 0) return arr;

  if (type === "diagnostic") {
    return [
      "Monitored vital signs and fetal heart rate.",
      "Assessed contraction pattern, frequency, duration, and intensity.",
      "Documented cervical findings and Bishop’s score."
    ];
  }

  if (type === "therapeutic") {
    return [
      "Positioned the patient for comfort and optimal uteroplacental perfusion.",
      "Provided supportive measures during contractions.",
      "Administered prescribed medications as ordered."
    ];
  }

  if (type === "educative") {
    return [
      "Explained the labor process and expected maternal responses.",
      "Instructed the patient on breathing and relaxation techniques.",
      "Reinforced the importance of reporting changes in pain, bleeding, or fetal movement."
    ];
  }

  return [];
}

app.get("/", (_req, res) => {
  res.send("AI NCP backend is running.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, aiReady: Boolean(process.env.GEMINI_API_KEY) });
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
You are assisting with an educational nursing care plan for a labor and delivery nursing context when applicable.

STRICT RULES:
1. Use only the provided data.
2. Do not invent unsupported facts.
3. Understand common medical abbreviations in objective nursing data.
4. Generate TOP 3 possible NANDA nursing diagnoses in order of best fit.
5. Select ONE primary diagnosis from the top 3.
6. The primary diagnosis must be written in full clinical nursing format whenever data supports it:
   "Problem related to [etiology] secondary to [condition if supported] as evidenced by [signs/symptoms/cues]"
7. If exact etiology is uncertain, still provide a reasonable "related to" statement based on the available cues.
8. Goals must be SMART, realistic, measurable, and appropriate to the case.
9. Short-term goal must begin exactly with:
   "At the end of the 8 hour shift..."
10. Long-term goal must begin exactly with:
   "After"
11. Provide NOC outcomes.
12. Provide interventions grouped EXACTLY into:
   - diagnosticInterventions
   - therapeuticInterventions
   - educativeInterventions
13. Every intervention must be in PAST TENSE.
14. The FIRST WORD of every intervention must be a past-tense nursing verb.
15. Diagnostic interventions must include assessment, observation, monitoring, or documentation actions.
16. Therapeutic interventions must include actual nursing actions already DONE.
17. Educative interventions must include teaching or health instructions already GIVEN.
18. If labor-related data is present, consider Bishop’s score, fetal heart rate, and uterine contractions.
19. Return VALID JSON only.
20. No markdown. No code fences.

JSON keys must be exactly:
topDiagnoses
primaryDiagnosis
rationaleNotes
nocOutcomes
diagnosticInterventions
therapeuticInterventions
educativeInterventions
shortTermGoal
longTermGoal

VALUE RULES:
- topDiagnoses: array of exactly 3 strings
- primaryDiagnosis: string
- rationaleNotes: string
- nocOutcomes: array of 3 to 6 strings
- diagnosticInterventions: array of 2 to 6 strings
- therapeuticInterventions: array of 2 to 6 strings
- educativeInterventions: array of 2 to 6 strings
- shortTermGoal: string
- longTermGoal: string

DE-IDENTIFIED CLINICAL DATA:
${JSON.stringify(clinicalData, null, 2)}
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        temperature: 0.15,
        responseMimeType: "application/json"
      }
    });

    const text = (response.text || "").trim();
    const parsed = JSON.parse(text);

    let topDiagnoses = cleanArray(parsed.topDiagnoses, 260, 3);

    if (topDiagnoses.length < 3) {
      const primary = cleanText(parsed.primaryDiagnosis, 500);
      topDiagnoses = [
        primary || "Review assessment cues for a primary NANDA diagnosis",
        "Risk for complications related to current clinical condition",
        "Further focused assessment may support another NANDA diagnosis"
      ].slice(0, 3);
    }

    let primaryDiagnosis = cleanText(parsed.primaryDiagnosis || topDiagnoses[0], 800);
    if (!primaryDiagnosis) {
      primaryDiagnosis = topDiagnoses[0];
    }

    primaryDiagnosis = ensureEtiology(primaryDiagnosis);

    res.json({
      topDiagnoses,
      primaryDiagnosis,
      rationaleNotes: cleanText(parsed.rationaleNotes, 1500),
      nocOutcomes: cleanArray(parsed.nocOutcomes, 280, 6),
      diagnosticInterventions: fallbackInterventions(parsed.diagnosticInterventions, "diagnostic"),
      therapeuticInterventions: fallbackInterventions(parsed.therapeuticInterventions, "therapeutic"),
      educativeInterventions: fallbackInterventions(parsed.educativeInterventions, "educative"),
      shortTermGoal: cleanText(parsed.shortTermGoal, 900),
      longTermGoal: cleanText(parsed.longTermGoal, 900)
    });
  } catch (error) {
    console.error("Gemini error:", error);
    res.status(500).json({
      error: error?.message || "Gemini generation failed"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Secure NCP backend listening on http://localhost:${PORT}`);
});
