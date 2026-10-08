---
id: python-web
title: Python web (Django, FastAPI, Flask)
---

## @developer
- Validate input with the framework's mechanism: Django forms/serializers, Pydantic models in FastAPI, or the project's schema library in Flask. Declare explicit fields — no `fields = '__all__'` on serializers that accept writes.
- Check object-level permissions (ownership) in views/endpoints, not only authentication.
- Use the ORM or parameterized queries; never format SQL strings with user input.
- For limits and counters use atomic updates (`F()` expressions / `select_for_update()` in Django, `UPDATE … WHERE` in SQLAlchemy).

## @qa
- Use the project's test client (`django.test.Client`, `fastapi.testclient.TestClient`, Flask's `app.test_client()`) and fixtures.
- Run the suite with the project's command (`pytest`, `python manage.py test`).

## @security
- `DEBUG = True`, permissive `ALLOWED_HOSTS`, CSRF exemptions, `mark_safe` / `|safe` on user content, `pickle` or `yaml.load` on untrusted data, `subprocess` with `shell=True`.

## @reviewer
- N+1 queries (missing `select_related` / `prefetch_related` / eager loading); business logic in views when the project uses services.
