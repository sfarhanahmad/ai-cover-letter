export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { job, company, name, experience, whyJob, tone, jd } = req.body;

    // Basic server-side validation
    if (!job || !company || !name || !experience || !whyJob) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Sanitize inputs
    const san = (s = '') => s.replace(/[<>]/g, '').replace(/ignore (previous|all) instructions?/gi, '').trim().slice(0, 1000);

    const jdPart = jd ? `\nJob description / key requirements:\n${san(jd)}` : '';

    const prompt = `Write a ${san(tone).toLowerCase()} cover letter for a job application.

Applicant: ${san(name)}
Applying for: ${san(job)} at ${san(company)}${jdPart}
Experience and skills: ${san(experience)}
Why they want this role: ${san(whyJob)}

Rules:
- Write a complete, ready-to-send cover letter
- Tone: ${san(tone).toLowerCase()}
- Do NOT open with clichés like "I am writing to express my interest"
- Mention the company and job title naturally in the text
- 3 to 4 paragraphs, flowing prose, no bullet points
- End with a confident call to action
- Do NOT use [brackets] or placeholder text
- Start with "Dear Hiring Manager," and close with the applicant's name
- Output only the letter — no preamble, no explanation`;

    const apiKey = process.env.GROQ_API_KEY;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        temperature: 0.8,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err?.error?.message || 'AI service error. Try again.' });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;

    if (!text) return res.status(500).json({ error: 'Empty response from AI. Please try again.' });

    return res.status(200).json({ letter: text });

  } catch (err) {
    console.error('Generate error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
