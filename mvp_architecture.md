# MVP Architecture: Personalized Webpage Productivity Classifier

## Problem Statement

We model productivity as a personalized, user-dependent property rather than a fixed property of a page. The task is to learn:

$$P(\text{productive} \mid u, i) = \sigma(s(u,i))$$

where $u$ is a user, $i$ is a webpage, $s(u,i)$ is a learned compatibility score, and $\sigma$ is the sigmoid function. This is a two-tower architecture: a user embedding and an item embedding are learned independently, then compared.

## Item Tower

$$g(i) = ss(i) = z_i$$

- $ss$ is a structure-and-semantics encoder over the page's rendered content (title, meta, headers, body text — extracted, not raw HTML).
- For MVP, $ss$ is a **frozen** off-the-shelf text embedding model (e.g. a BGE/GTE/E5-class sentence encoder), with extracted page text as input.
- $z_i$ is the resulting fixed-dimension page embedding.
- No URL features, no domain embedding, no collaborative ID embedding in v1 — content only.

## User Tower

$$f(u) = \frac{1}{|I_u|}\sum_{i \in I_u} z_i = z_u$$

- $I_u$ is the set of pages user $u$ has labeled.
- $z_u$ is the unweighted mean of the item embeddings of those labeled pages.
- This is a **user-free** representation in the FISM/AutoRec sense: there is no free per-user parameter vector. The user is represented entirely as a function of the items they've engaged with, which is what allows the model to handle users with very few labels without overfitting a dedicated embedding per user.

## Scoring and Training

$$s(u,i) = z_u \cdot z_i \quad \text{(or } \cos(z_u, z_i)\text{ if normalized)}$$

$$\hat{y}_{u,i} = \sigma(s(u,i))$$

Trained with binary cross-entropy against observed labels $y_{u,i} \in \{0,1\}$.

## Known v1 Simplifications (deliberate scope cuts)

- **Encoder is frozen.** No gradients flow into $ss$. All learning happens in whatever projection/scoring sits on top of $z_i$ and $z_u$ (currently: none beyond the raw dot product, since both towers emit raw frozen-embedding outputs in this draft).
- **Single pooled mean, not split by label.** $I_u$ pools *all* of a user's labeled items together, regardless of whether they were labeled productive or unproductive. This means $z_u$ does not yet distinguish "what I like" from "what I avoid" — a likely first upgrade if performance plateaus.
- **No domain, URL, or context (time-of-day) features.** Content embedding only.
- **No cold-start path for zero-label users.** A user with $|I_u| = 0$ has an undefined $z_u$.
- **No leakage guard specified yet.** Training examples must exclude the candidate item $i$ from $I_u$ when computing $z_u$ for that example.

These are reasonable, explicit MVP cuts — not oversights — and are the natural list of first upgrades once the baseline is running.
