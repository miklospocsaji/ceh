## ADDED Requirements

### Requirement: Resume guidance reaches the next role
The text of the `/resume` that started an execution SHALL reach the first role that runs in it, fenced as the owner's feedback, next to the failure evidence of the work item's last failed attempt when it was escalated. A build role SHALL receive it through its build input. Later roles SHALL NOT see it.

#### Scenario: Resume guidance reaches the next role
- **WHEN** a task escalated with `spec-ambiguity` is resumed with `/resume Treat an empty title as "Untitled"`
- **THEN** the next implementer attempt's prompt holds that text, fenced as the owner's feedback, next to the classifier's evidence, and the next task's prompts do not
