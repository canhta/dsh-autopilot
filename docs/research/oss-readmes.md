# OSS README structure references

First-party examples separate prospective users from contributors instead of making the repository homepage serve every audience equally.

| Example | Information architecture |
| --- | --- |
| [uv README](https://github.com/astral-sh/uv/blob/89c3b2c917f6b9b2f5c785747a31630a429904c4/README.md) | Product definition and highlights precede installation; feature examples link to deeper guides. Contribution details move to a separate page. |
| [uv contributing guide](https://github.com/astral-sh/uv/blob/89c3b2c917f6b9b2f5c785747a31630a429904c4/CONTRIBUTING.md) | Explains suitable work and coordination before setup, tests and tooling. |
| [Trigger.dev README](https://github.com/triggerdotdev/trigger.dev/blob/478422f4a38622cd0286c07a5e5f6a99825e1786/README.md) | Leads with user outcomes and product capabilities, then routes readers toward getting started, self-hosting and development. |
| [Trigger.dev contributing guide](https://github.com/triggerdotdev/trigger.dev/blob/478422f4a38622cd0286c07a5e5f6a99825e1786/CONTRIBUTING.md) | Keeps contributor coordination, prerequisites, local setup and testing together, away from the product introduction. |

## Application to dsh-autopilot

Recommended order: user value → what the plugin does and its boundaries → capabilities → installation availability → local development → contribution path. Keep the homepage scannable; link implementation contracts through the documentation map and detailed contribution rules through their owning guide.

Maturity qualifies the claims: planned capabilities are not shipped features, cloning documentation is not installing a plugin, and local development instructions must match existing files and commands. Borrow audience separation and progressive disclosure, not these projects' installation commands, badges, contributor restrictions, performance claims or infrastructure choices.
