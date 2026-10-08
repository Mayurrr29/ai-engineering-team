Instructors can create discount coupons for their own courses, and students can apply a coupon code when buying a course.

- `POST /courses/:id/coupons` with `{ code, percentOff, expiresAt?, maxRedemptions? }` creates a coupon and returns `201 { data: coupon }`.
- `POST /orders` accepts an optional `couponCode`; when a valid coupon is applied, the order `amount` is discounted.
