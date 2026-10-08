---
id: nestjs
title: NestJS
---

## @developer
- Validate input with DTOs and `class-validator`; make sure the global `ValidationPipe` uses `whitelist: true` (and ideally `forbidNonWhitelisted`) so unknown fields are stripped or rejected.
- Put authorization in guards and check resource ownership in the service, not only roles in decorators.
- Keep controllers thin: business logic belongs in services, data access in repositories, following the module structure.
- Throw Nest's HTTP exceptions (`NotFoundException`, `ConflictException`…) for expected failures.

## @qa
- Use the project's testing module setup (`Test.createTestingModule`) and `supertest` against the app for end-to-end tests if that's the existing pattern.

## @security
- Routes missing `@UseGuards` where sibling routes have it; `@Public()`-style decorators applied too broadly.
- Serialization: use `ClassSerializerInterceptor` / `@Exclude()` (or explicit DTOs) so entities with secrets aren't returned directly.

## @reviewer
- Circular module dependencies, providers registered in the wrong module, business logic in controllers.
