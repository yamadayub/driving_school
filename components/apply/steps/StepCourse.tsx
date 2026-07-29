'use client'

import { CheckboxGroup } from '@/components/ui/CheckboxGroup'
import { FormField } from '@/components/ui/FormField'
import { RadioCardGroup } from '@/components/ui/RadioCardGroup'
import {
  FORMAT_OPTIONS,
  PLAN_OPTIONS,
  SCHOOL_OPTIONS,
  type CourseOption,
  type Values,
} from '@/components/apply/form-model'

/** コース・校舎（APPLICATION 専用ステップ）。 */
export function StepCourse({
  courses,
  values,
  setValue,
  toggleInList,
}: {
  courses: CourseOption[]
  values: Values
  setValue: (field: string, value: unknown) => void
  toggleInList: (field: string, option: string) => void
}) {
  return (
    <section>
      <h2 className="text-h2 font-heading text-text-primary">コース・校舎をお選びください</h2>
      <CheckboxGroup
        legend="教習プラン（複数選択できます）"
        name="plans"
        options={PLAN_OPTIONS}
        selected={values.plans as string[]}
        onToggle={(option) => toggleInList('plans', option)}
      />
      <FormField id="courseId" label="コース" required>
        <select
          id="courseId"
          name="courseId"
          value={(values.courseId as string) ?? ''}
          onChange={(event) => setValue('courseId', event.target.value || null)}
          className="w-full rounded border border-border p-2"
        >
          <option value="">選択してください</option>
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.label}
            </option>
          ))}
        </select>
      </FormField>
      <RadioCardGroup
        legend="校舎"
        name="school"
        options={SCHOOL_OPTIONS}
        value={(values.school as string) ?? null}
        onChange={(value) => setValue('school', value)}
      />
      <RadioCardGroup
        legend="受講形態"
        name="format"
        options={FORMAT_OPTIONS}
        value={(values.format as string) ?? null}
        onChange={(value) => setValue('format', value)}
      />
    </section>
  )
}
