# common-passwords.txt.gz

The passwords `core/security.py` refuses as too common: NCSC's list of the
100,000 passwords most often found in breaches (via SecLists,
`Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`, MIT), kept
to those of 8 characters or more — the shortest minimum an instance may set —
lowercased, deduplicated and sorted. The check lowercases too.
