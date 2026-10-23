# Skills contract

Pi-session worker roles require their role contract skills (worker: `idea-to-pr`, `pr`, `build`; reviewer: `review-code`). Durable-conversation roles only use explicitly allowlisted skill text and default to no skills. Missing skills fail that `(kind, role)` closed; there is no fallback.
