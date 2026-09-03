# Conversation visibility and audience use scope administrators

Conversation remains the smallest collaboration and permission boundary. Channel and DM remain presets rather than parallel entities. Every Conversation stores immutable `public | private` visibility; DM is always private and fixes exactly two Workspace Memberships.

A public Workspace Channel projects all active Workspace Memberships, and a public Project Channel projects all active Project Memberships whose Workspace Membership remains active. It stores no audience rows. A private Workspace Channel stores exact Workspace Membership audience rows; a private Project Channel stores exact Project Membership audience rows. A later Membership for the same actor never matches an old private or DM grant.

Only an active Human Workspace Owner may create or govern a Workspace Channel, and only an active Human Project Manager may create or govern a Project Channel. No Conversation Owner, Channel Admin, join, or leave role is added. The creator is automatically included in a private audience but remains audit provenance rather than durable authority. Scope administrators may remove themselves or the last participant and retain governance access to basic metadata and audience management without Message, search, change-stream, Mention, Request, Run, or Agent inbox content access.

Private audience mutations use the Conversation revision and the normal idempotency contract. Removal atomically advances Conversation revision and context version, cancels affected pending Requests, and fences active Runs, Attempts, and Agent inbox work before later reads or writes can succeed. Visibility never mutates; changing disclosure creates a new Conversation. Public rejects explicit audience, and DM rejects visibility or participant governance changes.

This replaces the prior scope-derived-only Channel model. It ships in the stable schema v1 baseline with no migration, compatibility view, dual write, or runtime inference from an earlier development database; existing older databases must be rebuilt.
